const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.post('/mix', async (req, res) => {
  const { videoUrl, audioUrl, script } = req.body;
  
  if (!videoUrl || !audioUrl) {
    return res.status(400).json({ error: 'videoUrl and audioUrl required' });
  }

  const videoPath = '/tmp/video.mp4';
  const audioPath = '/tmp/audio.mp3';
  const outputPath = '/tmp/output.mp4';

  try {
    // Download files
    await downloadFile(videoUrl, videoPath);
    await downloadFile(audioUrl, audioPath);

    // Split script into 5-second segments for captions
    const words = script ? script.split(' ') : [];
    const wordsPerSegment = Math.ceil(words.length / 12);
    
    // Build drawtext filters for each segment
    let textFilters = [];
    for (let i = 0; i < 12; i++) {
      const start = i * wordsPerSegment;
      const end = Math.min((i + 1) * wordsPerSegment, words.length);
      let text = words.slice(start, end).join(' ');
      
      // Escape special characters for ffmpeg
      text = text
        .replace(/\\/g, '\\\\')  // Escape backslashes first
        .replace(/'/g, "'\\\\\\\\''")  // Escape single quotes
        .replace(/:/g, '\\:')  // Escape colons
        .replace(/—/g, '-')  // Replace em-dash with regular dash
        .replace(/'/g, "'")  // Replace smart quotes
        .replace(/"/g, '"')  // Replace smart quotes
        .replace(/'/g, "'");  // Replace smart quotes
      
      if (text) {
        const startTime = i * 5;
        const endTime = (i + 1) * 5;
        
        textFilters.push(
          `drawtext=text='${text}':fontsize=28:fontcolor=white:` +
          `borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-80:` +
          `enable='between(t\\,${startTime}\\,${endTime})'`
        );
      }
    }

    const complexFilter = [
      '[0:a]volume=0.15[bg]',
      '[1:a]volume=1.0[vo]',
      '[bg][vo]amix=inputs=2:duration=first[a]',
      `[0:v]${textFilters.join(',')}[v]`
    ];

    console.log('Starting ffmpeg with captions...');

    // Mix with ffmpeg
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .complexFilter(complexFilter)
        .outputOptions([
          '-map [v]',
          '-map [a]',
          '-c:v libx264',
          '-c:a aac',
          '-preset ultrafast'
        ])
        .output(outputPath)
        .on('end', () => {
          console.log('FFmpeg complete');
          resolve();
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err);
          reject(err);
        })
        .run();
    });

    // Send file back
    res.sendFile(outputPath);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

app.listen(PORT, () => {
  console.log(`Video mixer running on port ${PORT}`);
});
