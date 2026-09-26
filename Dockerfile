FROM node:26-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js ./
COPY lib ./lib
COPY public ./public
EXPOSE 3000
CMD ["node", "server.js"]
