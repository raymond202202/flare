#!/bin/bash
# Flare 安装脚本
# 安装到 ~/.flare/install/，与项目文件夹完全分离

set -e

FLARE_HOME="${FLARE_HOME:-$HOME/.flare}"
INSTALL_DIR="$FLARE_HOME/install"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "📦 安装 Flare..."

# 1. 确保 ~/.local/bin 存在
LOCAL_BIN="$HOME/.local/bin"
mkdir -p "$LOCAL_BIN"

# 2. 构建项目
echo "🔨 构建中..."
cd "$PROJECT_DIR"
npm run build --silent 2>/dev/null

# 3. 创建安装目录
mkdir -p "$INSTALL_DIR/dist"
mkdir -p "$INSTALL_DIR/bin"

# 4. 复制构建产物
echo "📋 复制文件到 $INSTALL_DIR"
cp -r "$PROJECT_DIR/dist/"* "$INSTALL_DIR/dist/"
cp -r "$PROJECT_DIR/node_modules" "$INSTALL_DIR/node_modules" 2>/dev/null || true
cp "$PROJECT_DIR/package.json" "$INSTALL_DIR/"

# 5. 创建启动脚本
cat > "$INSTALL_DIR/bin/flare" << 'WRAPPER'
#!/usr/bin/env node
import('../dist/cli/index.js').catch(e => {
  console.error('Flare 启动失败:', e.message)
  process.exit(1)
})
WRAPPER
chmod +x "$INSTALL_DIR/bin/flare"

# 6. 在 ~/.local/bin/ 创建软链
ln -sf "$INSTALL_DIR/bin/flare" "$LOCAL_BIN/flare"

# 7. 检查 PATH
if [[ ":$PATH:" != *":$LOCAL_BIN:"* ]]; then
  echo "⚠️  $LOCAL_BIN 不在 PATH 中，请添加到你的 shell 配置："
  echo "   echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
  echo "   source ~/.bashrc"
fi

echo ""
echo "✅ Flare 安装完成！"
echo "   项目目录: $PROJECT_DIR"
echo "   安装目录: $INSTALL_DIR"
echo "   命令路径: $LOCAL_BIN/flare"
echo ""
echo "现在可以运行: flare chat -q '你好！'"
echo ""
echo "首次使用别忘了配置 API Key："
echo "   cp $PROJECT_DIR/.env.example $INSTALL_DIR/.env"
echo "   nano $INSTALL_DIR/.env"
