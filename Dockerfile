# MCP MQTT Bridge Server
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

# 复制代码
COPY server.py .

# 暴露端口
EXPOSE 8000

# 启动服务
CMD ["python", "server.py"]
