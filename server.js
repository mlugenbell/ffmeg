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

        // Get audio duration first
        const getAudioDurationCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${workDir}/audio.mp3`;
        
        exec(getAudioDurationCmd, (durationError, durationStdout) => {
            const audioDuration = durationError ? 72 : Math.ceil(parseFloat(durationStdout));
            console.log(`Audio duration: ${audioDuration} seconds`);

            // Split script into chunks for subtitles
            const words = script ? script.split(' ') : [];
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

            // Calculate display duration for each subtitle line
            const lineDuration = lines.length > 0 ? audioDuration / lines.length : 3;

            // Create drawtext filters for subtitles
            let drawTextFilters = [];
            lines.forEach((line, index) => {
                const startTime = index * lineDuration;
                const endTime = startTime + lineDuration;
                const escapedLine = escapeText(line);
                
                drawTextFilters.push(
                    `drawtext=text='${escapedLine}':fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:fontsize=28:fontcolor=white:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-80:enable='between(t,${startTime},${endTime})'`
                );
            });

            const filterComplex = drawTextFilters.length > 0 ? drawTextFilters.join(',') : null;

            // Build ffmpeg command
            let ffmpegCommand;
            
            if (filterComplex && script) {
                // Try with subtitles
                ffmpegCommand = `ffmpeg -i ${workDir}/video.mp4 -i ${workDir}/audio.mp3 -filter_complex "[0:v]${filterComplex}[v]" -map "[v]" -map 1:a -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k ${workDir}/output.mp4`;
            } else {
                // Simple mix without subtitles
                ffmpegCommand = `ffmpeg -i ${workDir}/video.mp4 -i ${workDir}/audio.mp3 -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 ${workDir}/output.mp4`;
            }

            console.log('Running ffmpeg command...');
            console.log(ffmpegCommand);
            
            exec(ffmpegCommand, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
                if (error && filterComplex) {
                    console.error('FFmpeg error with subtitles, trying without...');
                    console.error('Error:', stderr);
                    
                    // Fallback to simple mixing without subtitles
                    const fallbackCommand = `ffmpeg -i ${workDir}/video.mp4 -i ${workDir}/audio.mp3 -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 ${workDir}/output.mp4`;
                    
                    exec(fallbackCommand, { maxBuffer: 1024 * 1024 * 10 }, (fallbackError) => {
                        if (fallbackError) {
                            console.error('Fallback also failed:', fallbackError);
                            return res.status(500).json({ error: 'Video processing failed' });
                        }
                        
                        console.log('Video processed successfully (without subtitles)');
                        const videoBuffer = fs.readFileSync(`${workDir}/output.mp4`);
                        res.set('Content-Type', 'video/mp4');
                        res.send(videoBuffer);
                        fs.rmSync(workDir, { recursive: true, force: true });
                    });
                    return;
                }

                if (error) {
                    console.error('FFmpeg error:', error);
                    return res.status(500).json({ error: 'Video processing failed', details: stderr });
                }

                console.log('Video processed successfully');
                const videoBuffer = fs.readFileSync(`${workDir}/output.mp4`);
                res.set('Content-Type', 'video/mp4');
                res.send(videoBuffer);
                fs.rmSync(workDir, { recursive: true, force: true });
            });
        });

    } catch (error) {
        console.error('Error:', error);
        fs.rmSync(workDir, { recursive: true, force: true });
        res.status(500).json({ error: 'Processing failed', details: error.message });
    }
});

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'Mixer service running - v3 with subtitle attempt' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
