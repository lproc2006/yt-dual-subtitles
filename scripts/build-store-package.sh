#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
VERSION="$(node -p "require('${PROJECT_DIR}/manifest.json').version")"
OUTPUT_DIR="${PROJECT_DIR}/release"
OUTPUT_FILE="${OUTPUT_DIR}/bilingual-subtitle-for-youtube-${VERSION}.zip"

mkdir -p "${OUTPUT_DIR}"
rm -f "${OUTPUT_FILE}"

(
  cd "${PROJECT_DIR}"
  zip -X -q -r "${OUTPUT_FILE}" manifest.json content icons popup privacy
)

PACKAGE_LIST="$(unzip -Z1 "${OUTPUT_FILE}")"
if print -r -- "${PACKAGE_LIST}" | grep -Eq '(^|/)(server|tests|cache|cache-v3|__pycache__|release|store|scripts)(/|$)|\.DS_Store$'; then
  print -u2 "发布包包含不允许的目录或缓存文件"
  exit 1
fi

for required in manifest.json content/content.js content/main-world.js popup/popup.html privacy/privacy.html icons/icon128.png; do
  if ! print -r -- "${PACKAGE_LIST}" | grep -Fxq "${required}"; then
    print -u2 "发布包缺少必需文件：${required}"
    exit 1
  fi
done

if zipgrep -En 'cookies-from-browser|ACCESS_TOKEN|remote-components|server/cache|AIza[0-9A-Za-z_-]{20,}' "${OUTPUT_FILE}" >/dev/null; then
  print -u2 "发布包中发现 Cookie 读取代码、本地服务源码、远程组件或固定 API 密钥残留"
  exit 1
fi

print "已生成：${OUTPUT_FILE}"
print "文件数量：$(print -r -- "${PACKAGE_LIST}" | grep -vc '/$')"
du -h "${OUTPUT_FILE}"
