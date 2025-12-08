const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'ffmpeg-mix-service' });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy' });
});

// Helper function to download file from URL
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        const protocol = url.startsWith('https') ? https : http;
        
        protocol.get(url, (response) => {
            // Handle redirects
            if (response.statusCode === 301 || response.statusCode === 302) {
                downloadFile(response.headers.location, dest)
                    .then(resolve)
                    .catch(reject);
                return;
            }
            
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

// Helper to escape text for ffmpeg drawtext
function escapeText(text) {
    if (!text) return '';
    return text
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "'\\''")
        .replace(/:/g, '\\:')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]');
}

// Main mix endpoint - combines video + voiceover audio
app.post('/mix', async (req, res) => {
    const { videoUrl, audioUrl, script } = req.body;
    
    console.log('=== MIX REQUEST ===');
    console.log('Video URL:', videoUrl);
    console.log('Audio URL:', audioUrl);
    console.log('Script length:', script ? script.length : 0);
    
    if (!videoUrl || !audioUrl) {
        return res.status(400).json({ error: 'videoUrl and audioUrl are required' });
    }

    const workDir = `/tmp/mix_${Date.now()}`;
    fs.mkdirSync(workDir, { recursive: true });

    const videoPath = `${workDir}/video.mp4`;
    const audioPath = `${workDir}/audio.mp3`;
    const outputPath = `${workDir}/output.mp4`;

    try {
        // Download video
        console.log('Downloading video...');
        await downloadFile(videoUrl, videoPath);
        console.log('Video downloaded');
        
        // Download audio
        console.log('Downloading audio...');
        await downloadFile(audioUrl, audioPath);
        console.log('Audio downloaded');

        // Get audio duration using ffprobe
        const getDurationCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`;
        
        exec(getDurationCmd, (durationErr, durationOut) => {
            let audioDuration = 60; // Default fallback
            
            if (!durationErr && durationOut) {
                audioDuration = Math.ceil(parseFloat(durationOut.trim()));
                console.log(`Audio duration: ${audioDuration} seconds`);
            } else {
                console.log('Could not get audio duration, using default 60s');
            }

            // FFmpeg command to mix video with voiceover
            // -map 0:v = use video from first input
            // -map 1:a = use audio from second input (voiceover)
            // -c:v copy = don't re-encode video
            // -c:a aac = encode audio as AAC
            // -t = limit to audio duration + buffer
            const ffmpegCmd = `ffmpeg -y -i "${videoPath}" -i "${audioPath}" -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -t ${audioDuration + 2} "${outputPath}"`;

            console.log('Running ffmpeg...');
            console.log('Command:', ffmpegCmd);

            exec(ffmpegCmd, { maxBuffer: 100 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) {
                    console.error('FFmpeg error:', error.message);
                    console.error('FFmpeg stderr:', stderr);
                    
                    // Cleanup
                    fs.rmSync(workDir, { recursive: true, force: true });
                    
                    return res.status(500).json({ 
                        error: 'FFmpeg processing failed',
                        details: error.message 
                    });
                }

                console.log('FFmpeg completed successfully');

                // Check if output file exists
                if (!fs.existsSync(outputPath)) {
                    fs.rmSync(workDir, { recursive: true, force: true });
                    return res.status(500).json({ error: 'Output file not created' });
                }

                // Get output file stats
                const stats = fs.statSync(outputPath);
                console.log(`Output file size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

                // Send the file
                res.setHeader('Content-Type', 'video/mp4');
                res.setHeader('Content-Disposition', 'attachment; filename="mixed_video.mp4"');
                res.setHeader('Content-Length', stats.size);
                res.setHeader('X-Audio-Duration', audioDuration.toString());

                const readStream = fs.createReadStream(outputPath);
                readStream.pipe(res);

                readStream.on('end', () => {
                    console.log('File sent successfully');
                    // Cleanup temp files
                    fs.rmSync(workDir, { recursive: true, force: true });
                });

                readStream.on('error', (streamErr) => {
                    console.error('Stream error:', streamErr);
                    fs.rmSync(workDir, { recursive: true, force: true });
                });
            });
        });

    } catch (err) {
        console.error('Error:', err.message);
        // Cleanup on error
        if (fs.existsSync(workDir)) {
            fs.rmSync(workDir, { recursive: true, force: true });
        }
        res.status(500).json({ error: err.message });
    }
});

// Endpoint to just get audio duration
app.post('/audio-duration', async (req, res) => {
    const { audioUrl } = req.body;
    
    if (!audioUrl) {
        return res.status(400).json({ error: 'audioUrl is required' });
    }

    const workDir = `/tmp/duration_${Date.now()}`;
    fs.mkdirSync(workDir, { recursive: true });
    const audioPath = `${workDir}/audio.mp3`;

    try {
        await downloadFile(audioUrl, audioPath);
        
        const getDurationCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`;
        
        exec(getDurationCmd, (err, stdout) => {
            fs.rmSync(workDir, { recursive: true, force: true });
            
            if (err) {
                return res.status(500).json({ error: 'Could not get duration' });
            }
            
            const duration = parseFloat(stdout.trim());
            res.json({ duration, durationRounded: Math.ceil(duration) });
        });
    } catch (err) {
        if (fs.existsSync(workDir)) {
            fs.rmSync(workDir, { recursive: true, force: true });
        }
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`FFmpeg mix service running on port ${PORT}`);
});
