#!/bin/bash
# 奶酪大盗游戏 - 每次启动脚本

cd ~/cheese-thief

# 获取本机IP（局域网）
IP=$(ip route get 1 2>/dev/null | awk '{print $7; exit}')
if [ -z "$IP" ]; then
  IP=$(ifconfig 2>/dev/null | grep 'inet ' | grep -v '127.0.0.1' | awk '{print $2}' | head -1)
fi
if [ -z "$IP" ]; then
  IP="你的手机IP"
fi

echo ""
echo "🧀 奶酪大盗游戏启动中..."
echo ""
echo "📱 其他人扫描二维码或访问："
echo ""
echo "   http://$IP:3000"
echo ""
echo "💡 提示："
echo "   1. 确保所有手机连接到同一个WiFi或热点"
echo "   2. 本手机开热点：设置 → 个人热点 → 开启"
echo "   3. 其他手机连热点后，浏览器输入上面的地址"
echo ""
echo "按 Ctrl+C 停止游戏"
echo "================================"

node server.js
