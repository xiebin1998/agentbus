#!/bin/sh
# mosquitto/bootstrap.sh：首次启动初始化 dynsec 管理员 + 为 hub 连接授予全量 topic 权限
# （compose entrypoint 以 /bin/sh 显式执行，规避 Windows 挂载丢失可执行位）
#
# 实测 2.1.2 结论：
#  - `mosquitto_ctrl dynsec init <file> <user> <pass>` 离线建库可用；
#  - 但 `mosquitto_ctrl -f <file> dynsec ...` 离线改库【静默无效】，角色/ACL 写不进去；
#  - 因此授权改为【运行时模式】：先把 broker 后台拉起，等就绪后用 mosquitto_ctrl
#    联网（admin 身份）createRole/addRoleACL/addClientRole。
FIRST_BOOT=0
if [ ! -f /mosquitto/data/dynsec.json ]; then
  FIRST_BOOT=1
  # init 只授予 admin 的 $CONTROL 管理权限（不含普通 topic 发布）
  mosquitto_ctrl dynsec init /mosquitto/data/dynsec.json "$DYNSEC_ADMIN_USER" "$DYNSEC_ADMIN_PASSWORD"
  # entrypoint 以 root 跑，而 mosquitto 降权为 mosquitto 用户 → 移交属主
  chown mosquitto:mosquitto /mosquitto/data/dynsec.json 2>/dev/null || true
  chmod 600 /mosquitto/data/dynsec.json 2>/dev/null || true
fi

# 后台拉起 broker（后面要做运行时授权；末尾 wait 保持容器存活）
mosquitto -c /mosquitto/config/mosquitto.conf &
BROKER_PID=$!

if [ "$FIRST_BOOT" = "1" ]; then
  # 等 broker 就绪（admin 能连上 $CONTROL 即视为可用）
  i=0
  while [ "$i" -lt 30 ]; do
    if mosquitto_ctrl -h 127.0.0.1 -p 1883 -u "$DYNSEC_ADMIN_USER" -P "$DYNSEC_ADMIN_PASSWORD" \
        dynsec listRoles >/dev/null 2>&1; then
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  # hub 共享连接（admin 身份）需要向普通 channel/metric topic 发布（send_message 转发），
  # init 的 admin 角色只有 $CONTROL 与「订阅/接收」全量权限，缺 publishClientSend → 补一个 hub-admin 角色。
  CTRL="mosquitto_ctrl -h 127.0.0.1 -p 1883 -u $DYNSEC_ADMIN_USER -P $DYNSEC_ADMIN_PASSWORD dynsec"
  $CTRL createRole hub-admin
  $CTRL addRoleACL hub-admin publishClientSend '#' allow
  $CTRL addRoleACL hub-admin publishClientReceive '#' allow
  $CTRL addRoleACL hub-admin subscribePattern '#' allow
  $CTRL addRoleACL hub-admin unsubscribePattern '#' allow
  $CTRL addClientRole "$DYNSEC_ADMIN_USER" hub-admin
fi

# 保持容器存活：等待 broker 子进程
wait "$BROKER_PID"
