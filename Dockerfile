FROM node:18-alpine

# Install ffmpeg AND font libraries for subtitle rendering
RUN apk add --no-cache \
    ffmpeg \
    fontconfig \
    ttf-dejavu \
    msttcorefonts-installer \
    && update-ms-fonts

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["npm", "start"]
