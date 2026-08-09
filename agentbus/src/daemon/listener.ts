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
  /** 订阅 topic：/phnix/ai/channel/<ns>/<client_id>/message */
  topic: string;
  /** 收到消息（原始 JSON 字符串）；解析与路由在 daemon 侧 */
  onMessage: (payloadJson: string, topic: string) => void;
  /** 状态回调（日志用） */
  onStatus?: (status: "connecting" | "connected" | "reconnecting" | "offline" | "error", detail?: string) => void;
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

export function createListener(opts: ListenerOptions): Listener {
  let client: MqttClient | null = null;
  // 就绪门控：SUBACK 未到前报 connected 会丢早到消息（首连无持久会话可补投）
  let subscribed = false;

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
          reconnectPeriod: 2000,
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
