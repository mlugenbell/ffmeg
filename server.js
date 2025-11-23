const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const app = express();

app.use(express.json({ limit: '50mb' }));

// Helper function to download file
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
}

// Helper to escape text for ffmpeg
function escapeText(text) {
    // Remove quotes and special characters that break ffmpeg
    return text.replace(/['":\\]/g, '').replace(/\n/g, ' ');
}

// Main mix endpoint
app.post('/mix', async (req, res) => {
    const { videoUrl, audioUrl, script } = req.body;
    
    if (!videoUrl || !audioUrl) {
        return res.status(400).json({ error: 'videoUrl and audioUrl required' });
    }

    const workDir = `/tmp/${Date.now()}`;
    fs.mkdirSync(workDir, { recursive: true });

    try {
        console.log('Downloading video...');
        await downloadFile(videoUrl, `${workDir}/video.mp4`);
        
        console.log('Downloading audio...');
        await downloadFile(audioUrl, `${workDir}/audio.mp3`);

        // Split script into chunks for subtitles (40 chars per line)
        const words = script.split(' ');
        let lines = [];
        let currentLine = '';
        
        words.forEach(word => {
            if ((currentLine + ' ' + word).length > 40) {
                lines.push(currentLine.trim());
                currentLine = word;
            } else {
                currentLine = currentLine ? `${currentLine} ${word}` : word;
            }
        });
        if (currentLine) lines.push(currentLine.trim());

        // Calculate display duration for each line (total audio duration / number of lines)
        const duration = 60; // Assuming 60 second video
        const lineDuration = duration / lines.length;

        // Create drawtext filter for each subtitle line
        let drawTextFilters = [];
        lines.forEach((line, index) => {
            const startTime = index * lineDuration;
            const endTime = startTime + lineDuration;
            const escapedLine = escapeText(line);
            
            drawTextFilters.push(
                `drawtext=text='${escapedLine}':fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:fontsize=28:fontcolor=white:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-80:enable='between(t,${startTime},${endTime})'`
            );
        });

        // Join all drawtext filters
        const filterComplex = drawTextFilters.join(',');

        // Mix video with audio and add subtitles
        const ffmpegCommand = `ffmpeg -i ${workDir}/video.mp4 -i ${workDir}/audio.mp3 -filter_complex "[0:v]${filterComplex}[v]" -map "[v]" -map 1:a -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -shortest ${workDir}/output.mp4`;

        console.log('Running ffmpeg command...');
        
        exec(ffmpegCommand, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error) {
                console.error('FFmpeg error:', error);
                console.error('FFmpeg stderr:', stderr);
                
                // If subtitles fail, try without them
                console.log('Trying without subtitles...');
                const fallbackCommand = `ffmpeg -i ${workDir}/video.mp4 -i ${workDir}/audio.mp3 -c:v copy -c:a aac -shortest ${workDir}/output.mp4`;
                
                exec(fallbackCommand, { maxBuffer: 1024 * 1024 * 10 }, (fallbackError, fallbackStdout, fallbackStderr) => {
                    if (fallbackError) {
                        return res.status(500).json({ error: 'Video processing failed' });
                    }
                    
                    // Send video without subtitles
                    const videoBuffer = fs.readFileSync(`${workDir}/output.mp4`);
                    res.set('Content-Type', 'video/mp4');
                    res.send(videoBuffer);
                    
                    // Cleanup
                    fs.rmSync(workDir, { recursive: true, force: true });
                });
                return;
            }

            console.log('Video processed successfully');
            
            // Read and send the output
            const videoBuffer = fs.readFileSync(`${workDir}/output.mp4`);
            res.set('Content-Type', 'video/mp4');
            res.send(videoBuffer);

            // Cleanup
            fs.rmSync(workDir, { recursive: true, force: true });
        });

    } catch (error) {
        console.error('Error:', error);
        fs.rmSync(workDir, { recursive: true, force: true });
        res.status(500).json({ error: 'Processing failed', details: error.message });
    }
});

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'Mixer service running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
