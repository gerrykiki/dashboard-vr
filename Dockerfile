# node:24-alpine，用 digest 釘住版本避免 build 結果隨時間漂移
# 更新方式：curl -sI -H "Accept: application/vnd.oci.image.index.v1+json" \
#   -H "Authorization: Bearer $(curl -s 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")" \
#   https://registry-1.docker.io/v2/library/node/manifests/24-alpine | grep -i docker-content-digest
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

WORKDIR /app

# 先複製 package 檔案
COPY package*.json ./

# 安裝正式環境套件
RUN npm ci --omit=dev

# 複製程式碼
COPY . .

# 建立 JSON 資料資料夾，並將擁有權交給非 root 使用者
RUN mkdir -p /app/data && chown -R node:node /app

# 以非 root 使用者執行，降低容器風險
USER node

# 開放 Node.js 服務埠號
EXPOSE 3000

# 健康檢查：確認伺服器有回應
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 使用 npm start 啟動
CMD ["npm", "start"]

