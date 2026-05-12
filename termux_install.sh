#!/bin/bash
# 奶酪大盗游戏 - Termux 一键安装脚本
# 在 Termux 中运行：bash termux_install.sh

echo "🧀 奶酪大盗游戏 - 安装中..."
echo ""

# 更新包管理器
echo "📦 更新软件包..."
pkg update -y && pkg upgrade -y

# 安装 Node.js 和 git
echo "📦 安装 Node.js 和 git..."
pkg install -y nodejs git

# 克隆游戏代码
echo "📥 下载游戏代码..."
cd ~
rm -rf cheese-thief
git clone https://github.com/Zoeyeely/cheese-thief.git
cd cheese-thief

# 安装依赖
echo "📦 安装游戏依赖..."
npm install

echo ""
echo "✅ 安装完成！"
echo ""
echo "👉 以后每次玩游戏，运行："
echo "   bash ~/cheese-thief/start.sh"
echo ""
