#!/usr/bin/env bash
# Flare 推荐本地模型一键拉取（混合模式：简单任务走本地小模型，省钱/隐私/离线）
#
# 背景：用户机器 64GB 内存 + 4GB 显存，混合模式方向——简单任务路由到本地 Ollama 模型。
# 本脚本拉取官方推荐的轻量/高性价比模型，与 docs/multi-model.md「推荐模型拉取」章节对应。
#
# 用法：
#   scripts/pull-recommended-models.sh             # 拉取全部推荐模型
#   scripts/pull-recommended-models.sh qwen3:1.7b  # 只拉取指定模型（可多个）
#   scripts/pull-recommended-models.sh --list      # 仅列出推荐模型与用途（不拉取）
#
# 说明：本脚本仅调用本地 ollama CLI，不涉及任何网络凭据/密钥。

set -euo pipefail

# 推荐模型（Ollama 命名）：轻量优先，64GB 内存 + 4GB 显存友好
# 格式：模型名|用途说明
RECOMMENDED=(
  "qwen3:1.7b|轻量通用对话（简单问答/分类/抽取/摘要/翻译/格式化）"
  "deepseek-r1:1.5b|轻量推理（简单逻辑/解释，DeepSeek-R1 蒸馏版）"
  "qwen3:30b-a3b|MoE 高性价比大模型（30B 总参/3B 激活，复杂文本理解，显存占用低）"
)

# 检查 ollama 是否可用
has_ollama() {
  command -v ollama >/dev/null 2>&1
}

# 列出推荐模型（不拉取）
list_recommended() {
  echo "📋 Flare 推荐本地模型（Ollama 命名）："
  for entry in "${RECOMMENDED[@]}"; do
    name="${entry%%|*}"
    desc="${entry#*|}"
    printf "  - %-18s %s\n" "$name" "$desc"
  done
  echo ""
  echo "💡 拉取后在 ~/.flare/.env 配置 LOCAL_MODEL=<模型名>（如 qwen3:1.7b），"
  echo "   再用 flare route \"<任务文本>\" 验证简单任务是否路由到本地模型。"
}

# 拉取单个模型
pull_one() {
  local model="$1"
  echo "⏳ 拉取 $model ..."
  ollama pull "$model"
  echo "✅ $model 就绪"
}

main() {
  if [[ $# -gt 0 && "$1" == "--list" ]]; then
    list_recommended
    return 0
  fi

  if ! has_ollama; then
    echo "❌ 未找到 ollama 命令。请先安装 Ollama：https://ollama.com" >&2
    echo "   安装后启动服务：ollama serve" >&2
    exit 1
  fi

  if [[ $# -eq 0 ]]; then
    # 无参数：拉取全部推荐模型
    list_recommended
    echo ""
    echo "🚀 开始拉取全部推荐模型..."
    for entry in "${RECOMMENDED[@]}"; do
      pull_one "${entry%%|*}"
    done
    echo ""
    echo "🎉 全部推荐模型拉取完成！"
    return 0
  fi

  # 有参数：校验并拉取指定模型（可多个）
  local unknown=0
  for model in "$@"; do
    local found=0
    for entry in "${RECOMMENDED[@]}"; do
      if [[ "$model" == "${entry%%|*}" ]]; then
        found=1
        break
      fi
    done
    if [[ $found -eq 0 ]]; then
      echo "⚠️  未知推荐模型：$model（可用：qwen3:1.7b / deepseek-r1:1.5b / qwen3:30b-a3b）" >&2
      unknown=1
    fi
  done
  if [[ $unknown -eq 1 ]]; then
    echo "提示：可用 --list 查看完整推荐清单。" >&2
    exit 1
  fi

  for model in "$@"; do
    pull_one "$model"
  done
}

main "$@"
