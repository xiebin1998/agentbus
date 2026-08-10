#!/bin/sh
# mosquitto/bootstrap.sh：首次启动初始化 dynsec 管理员，然后前台跑 mosquitto
# （compose entrypoint 以 /bin/sh 显式执行，规避 Windows 挂载丢失可执行位）
if [ ! -f /mosquitto/data/dynsec.json ]; then
  mosquitto_ctrl dynsecinit /mosquitto/data/dynsec.json -c "$DYNSEC_ADMIN_USER" "$DYNSEC_ADMIN_PASSWORD"
fi
exec mosquitto -c /mosquitto/config/mosquitto.conf
