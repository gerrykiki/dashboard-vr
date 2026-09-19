FROM node:24-alpine

WORKDIR /app

# 先複製 package 檔案
COPY package*.json ./

# 安裝正式環境套件
RUN npm ci --omit=dev

# 複製程式碼
COPY . .

# 建立 JSON 資料資料夾
RUN mkdir -p /app/data

# 開放 Node.js 服務埠號
EXPOSE 3000

# 使用 npm start 啟動
CMD ["npm", "start"]

