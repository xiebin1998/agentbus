# MCP MQTT Bridge Server（多阶段：node 构建 Web 控制台 → python 运行时托管）

# ── 阶段 1：Web 控制台构建（React + Vite） ──
FROM node:22-alpine AS web-builder
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
RUN npm run build

# ── 阶段 2：Python 运行时 ──
FROM python:3.11-slim

# 设置工作目录
WORKDIR /app

# 设置环境变量
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MQTT_BROKER_HOST=localhost \
    MQTT_BROKER_PORT=1883 \
    MQTT_USERNAME= \
    MQTT_PASSWORD= \
    MQTT_USE_TLS=false \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8000

# 安装依赖
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制代码（hub/ 为四期账号体系包；scripts/ 安装脚本为运行时托管静态资源）
COPY server.py .
COPY hub/ hub/
COPY scripts/ scripts/
# Web 控制台构建产物（server.py 挂载 /console 静态托管）
COPY --from=web-builder /web/dist web/dist

# 暴露端口
EXPOSE 8000

# 启动服务
CMD ["python", "server.py"]
