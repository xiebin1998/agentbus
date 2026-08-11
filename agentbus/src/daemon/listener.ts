/**
 * TASK-05: Daemon MQTT 层（架构 5.3）
 *
 * 连接语义红线：
 * - cleanSession:false —— 掉线期间 broker 保留 QoS>0 消息，重连后补发（与去重 LRU 配合）
 * - 固定 clientId（agentbus-<ns>-<client_id>）—— 防多实例互踢；重连复用同一身份
 * - 订阅 QoS 2 —— 与 hub publish 对齐，至少一次投递由去重兜底
 */
import mqtt, { type MqttClient, type IClientOptions } from "mqtt";
import { readFileSync } from "node:fs";
import type { BrokerConfig } from "../config.js";

export interface ListenerOptions {
  broker: BrokerConfig;
  /** 连接 clientId：agentbus-<ns>-<client_id> */
  clientId: string;
  /** 订阅 topic：/agentbus/ai/channel/<ns>/<client_id>/message */
  topic: string;
  /** 收到消息（原始 JSON 字符串）；解析与路由在 daemon 侧 */
  onMessage: (payloadJson: string, topic: string) => void;
  /** 状态回调（日志用）；identity_conflict = TASK-32 断连指纹（同 clientId 互踢） */
  onStatus?: (status: "connecting" | "connected" | "reconnecting" | "offline" | "error" | "identity_conflict", detail?: string) => void;
  /** 重连间隔（默认 2000ms；测试注入短间隔加速指纹观测） */
  reconnectPeriodMs?: number;
}

export interface Listener {
  start(): Promise<void>;
  stop(): Promise<void>;
  publish(topic: string, payloadJson: string): Promise<void>;
  isConnected(): boolean;
}

/**
 * TASK-25：由 broker 配置构造 mqtt.connect 选项（纯函数，便于单测）。
 * TLS 时校验证书；配置 ca（自签 CA 路径）时加载为信任锚，文件缺失直接抛错。
 */
export function buildConnectOptions(broker: BrokerConfig): IClientOptions {
  const opts: IClientOptions = {
    clean: false,
    username: broker.username || undefined,
    password: broker.password || undefined,
  };
  if (broker.tls) {
    opts.rejectUnauthorized = true;
    if (broker.ca) {
      opts.ca = [readFileSync(broker.ca)];
    }
  }
  return opts;
}

/**
 * TASK-32：断连指纹判定（纯函数）——窗口内非主动断连次数达阈即判身份冲突。
 * 典型成因：另一台机器/项目用同一 client_id 接入，broker 同 clientId 互踢。
 */
export function disconnectConflict(
  stamps: number[],
  now: number,
  windowMs = 60_000,
  threshold = 3,
): boolean {
  return stamps.filter((t) => now - t <= windowMs).length >= threshold;
}

/** TASK-32：身份冲突指引文案（修复手段二选一） */
export const CONFLICT_GUIDANCE =
  "疑似 client_id 碰撞互踢：重跑 agentbus init 重新随机 client_id，或用 --client-id 指定唯一身份";

export function createListener(opts: ListenerOptions): Listener {
  let client: MqttClient | null = null;
  // 就绪门控：SUBACK 未到前报 connected 会丢早到消息（首连无持久会话可补投）
  let subscribed = false;
  // TASK-32：断连指纹状态（主动 stop 不计；冲突判定只发一次）
  let stopping = false;
  let conflicted = false;
  const disconnectStamps: number[] = [];

  const buildUrl = (): string => {
    const proto = opts.broker.tls ? "mqtts" : "mqtt";
    return `${proto}://${opts.broker.host}:${opts.broker.port}`;
  };

  return {
    start() {
      return new Promise<void>((resolve, reject) => {
        opts.onStatus?.("connecting", buildUrl());
        client = mqtt.connect(buildUrl(), {
          ...buildConnectOptions(opts.broker),
          clientId: opts.clientId,
          reconnectPeriod: opts.reconnectPeriodMs ?? 2000,
          connectTimeout: 10_000,
        });

        let firstConnect = true;
        client.on("connect", () => {
          subscribed = false;
          client!.subscribe(opts.topic, { qos: 2 }, (err) => {
            if (err) {
              opts.onStatus?.("error", `订阅失败: ${err.message}`);
            } else {
              subscribed = true;
              opts.onStatus?.("connected");
            }
            // 无论成败都解阻塞 start()：连接已建立，订阅失败仅降级为未就绪（日志已记）
            if (firstConnect) {
              firstConnect = false;
              resolve();
            }
          });
        });
        client.on("reconnect", () => opts.onStatus?.("reconnecting"));
        client.on("offline", () => opts.onStatus?.("offline"));
        // TASK-32：非主动断连指纹；达阈即停重连并报 identity_conflict（daemon 收到后退出码 2）
        client.on("close", () => {
          if (stopping || conflicted) return;
          const now = Date.now();
          disconnectStamps.push(now);
          while (disconnectStamps.length > 0 && now - disconnectStamps[0] > 60_000) {
            disconnectStamps.shift();
          }
          if (disconnectConflict(disconnectStamps, now)) {
            conflicted = true;
            // mqtt.js 重连调度时读取该值：置 0 即永久停止重连
            client!.options.reconnectPeriod = 0;
            // mqtt.js 内部 close 处理器先于我们调度了 setInterval 重连：当场清掉，否则还有一次在途重连
            const raw = client as unknown as { reconnectTimer?: ReturnType<typeof setInterval> };
            if (raw.reconnectTimer) {
              clearInterval(raw.reconnectTimer);
              raw.reconnectTimer = undefined;
            }
            opts.onStatus?.("identity_conflict", CONFLICT_GUIDANCE);
          }
        });
        client.on("error", (err) => {
          opts.onStatus?.("error", err.message);
          if (firstConnect) {
            firstConnect = false;
            reject(err);
          }
        });
        client.on("message", (topic, payload) => {
          opts.onMessage(payload.toString("utf-8"), topic);
        });
      });
    },

    stop() {
      return new Promise<void>((resolve) => {
        subscribed = false;
        stopping = true; // 主动停止不计入断连指纹
        if (!client) return resolve();
        client.end(false, () => resolve());
        client = null;
      });
    },

    publish(topic, payloadJson) {
      return new Promise<void>((resolve, reject) => {
        if (!client || !client.connected) {
          return reject(new Error("MQTT 未连接，无法 publish"));
        }
        client.publish(topic, payloadJson, { qos: 2 }, (err) => (err ? reject(err) : resolve()));
      });
    },

    isConnected() {
      return subscribed && (client?.connected ?? false);
    },
  };
}
