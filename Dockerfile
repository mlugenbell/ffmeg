FROM ubuntu:22.04

RUN apt-get update && apt-get install -y \
    ffmpeg \
    nodejs \
    npm \
    fonts-liberation \
    fontconfig

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["npm", "start"]
