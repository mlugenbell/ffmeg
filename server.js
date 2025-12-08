const express = require('express');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// Original audio upload endpoint
app.post('/upload-audio', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file uploaded' });
    }

    const fileName = `audio/${Date.now()}-${Math.random().toString(36).substring(7)}.mp3`;
    
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileName,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));

    const tempPath = `/tmp/temp-${Date.now()}.mp3`;
    fs.writeFileSync(tempPath, req.file.buffer);
    
    const duration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(tempPath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration);
      });
    });
    
    fs.unlinkSync(tempPath);

    res.json({
      url: `${process.env.R2_PUBLIC_URL}/${fileName}`,
      duration: duration
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mix voiceover with background music
app.post('/mix-audio', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file uploaded' });
    }

    const backgroundMusicUrl = 'https://cdn.pixabay.com/download/audio/2022/05/27/audio_1808fbf07a.mp3';
    
    const bgResponse = await fetch(backgroundMusicUrl);
    const bgBuffer = Buffer.from(await bgResponse.arrayBuffer());
    
    const bgPath = `/tmp/bg-${Date.now()}.mp3`;
    const voicePath = `/tmp/voice-${Date.now()}.mp3`;
    const outputPath = `/tmp/mixed-${Date.now()}.mp3`;
    
    fs.writeFileSync(bgPath, bgBuffer);
    fs.writeFileSync(voicePath, req.file.buffer);
    
    console.log('Mixing audio files...');
    
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(voicePath)
        .input(bgPath)
        .complexFilter([
          '[0:a]volume=1.0[voice]',
          '[1:a]volume=0.15[bg]',
          '[voice][bg]amix=inputs=2:duration=first'
        ])
        .audioCodec('libmp3lame')
        .audioBitrate('192k')
        .on('end', () => {
          console.log('Audio mixing complete');
          resolve();
        })
        .on('error', (err) => {
          console.error('FFMPEG error:', err);
          reject(err);
        })
        .save(outputPath);
    });
    
    const mixedBuffer = fs.readFileSync(outputPath);
    const fileName = `audio/${Date.now()}-${Math.random().toString(36).substring(7)}.mp3`;
    
    console.log('Uploading mixed audio to R2...');
    
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileName,
      Body: mixedBuffer,
      ContentType: 'audio/mpeg'
    }));
    
    const duration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(outputPath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration);
      });
    });
    
    console.log(`Mixed audio uploaded. Duration: ${duration}s`);
    
    fs.unlinkSync(bgPath);
    fs.unlinkSync(voicePath);
    fs.unlinkSync(outputPath);
    
    res.json({
      url: `${process.env.R2_PUBLIC_URL}/${fileName}`,
      duration: duration
    });
    
  } catch (error) {
    console.error('Mix error:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
