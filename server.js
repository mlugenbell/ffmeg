const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const https = require('https');
const fetch = require('node-fetch');
const FormData = require('form-data');
const app = express();

app.use(express.json({ limit: '50mb' }));

// Helper to remove directory
function removeDir(dir) {
    if (fs.existsSync(dir)) {
        if (fs.rmSync) {
            fs.rmSync(dir, { recursive: true, force: true });
        } else {
            fs.rmdirSync(dir, { recursive: true });
        }
    }
}

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

// Helper to get video duration
function getVideoDuration(filePath) {
    return new Promise((resolve, reject) => {
        exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`, (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                resolve(parseFloat(stdout.trim()));
            }
        });
    });
}

// Helper to upload video to R2
async function uploadVideoToR2(filePath) {
    const formData = new FormData();
    formData.append('video', fs.createReadStream(filePath), {
        filename: `mixed-video-${Date.now()}.mp4`,
        contentType: 'video/mp4'
    });

    const response = await fetch('https://r2-upload-service-production.up.railway.app/upload-video', {
        method: 'POST',
        body: formData,
        headers: formData.getHeaders()
    });

    if (!response.ok) {
        throw new Error(`R2 upload failed: ${response.statusText}`);
    }

    return await response.json();
}

// Main mix endpoint
app.post('/mix', async (req, res) => {
    const { videoUrl, audioUrl, srtContent } = req.body;
    
    if (!videoUrl || !audioUrl) {
        return res.status(400).json({ error: 'videoUrl and audioUrl required' });
    }

    const workDir = `/tmp/${Date.now()}`;
    fs.mkdirSync(workDir, { recursive: true });

    try {
        console.log('Downloading files...');
        await downloadFile(videoUrl, `${workDir}/video.mp4`);
        await downloadFile(audioUrl, `${workDir}/audio.mp3`);

        // Get audio duration
        const audioDuration = await getVideoDuration(`${workDir}/audio.mp3`);
        console.log(`Audio duration: ${audioDuration}s`);

        let ffmpegCommand;
        
        if (srtContent) {
            const srtPath = `${workDir}/subtitles.srt`;
            fs.writeFileSync(srtPath, srtContent, 'utf8');
            console.log('SRT file created');
            
            ffmpegCommand = `ffmpeg -y -i "${workDir}/video.mp4" -i "${workDir}/audio.mp3" -filter_complex "[0:a]volume=0.15[bg];[1:a]volume=1.0[vo];[bg][vo]amix=inputs=2:duration=longest[aout];[0:v]subtitles='${srtPath}':force_style='FontSize=24,PrimaryColour=&Hffffff&,OutlineColour=&H000000&,Outline=2,MarginV=40'[vout]" -map "[vout]" -map "[aout]" -c:v libx264 -preset ultrafast -crf 23 -c:a aac -b:a 128k -t ${Math.ceil(audioDuration)} "${workDir}/output.mp4"`;
        } else {
            ffmpegCommand = `ffmpeg -y -i "${workDir}/video.mp4" -i "${workDir}/audio.mp3" -filter_complex "[0:a]volume=0.15[bg];[1:a]volume=1.0[vo];[bg][vo]amix=inputs=2:duration=longest[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 128k -t ${Math.ceil(audioDuration)} "${workDir}/output.mp4"`;
        }

        console.log('Running ffmpeg...');
        
        exec(ffmpegCommand, { maxBuffer: 1024 * 1024 * 10 }, async (error, stdout, stderr) => {
            if (error) {
                console.error('FFmpeg error:', stderr);
                
                if (srtContent) {
                    console.log('Retrying without subtitles...');
                    const fallbackCommand = `ffmpeg -y -i "${workDir}/video.mp4" -i "${workDir}/audio.mp3" -filter_complex "[0:a]volume=0.15[bg];[1:a]volume=1.0[vo];[bg][vo]amix=inputs=2:duration=longest[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 128k -t ${Math.ceil(audioDuration)} "${workDir}/output.mp4"`;
                    
                    exec(fallbackCommand, { maxBuffer: 1024 * 1024 * 10 }, async (fallbackError) => {
                        if (fallbackError) {
                            removeDir(workDir);
                            return res.status(500).json({ error: 'Processing failed' });
                        }
                        
                        try {
                            const uploadResult = await uploadVideoToR2(`${workDir}/output.mp4`);
                            console.log('Upload successful (no subtitles)');
                            removeDir(workDir);
                            res.json({
                                success: true,
                                url: uploadResult.url,
                                duration: audioDuration
                            });
                        } catch (uploadError) {
                            console.error('Upload error:', uploadError);
                            removeDir(workDir);
                            res.status(500).json({ error: 'Upload failed' });
                        }
                    });
                    return;
                }
                
                removeDir(workDir);
                return res.status(500).json({ error: 'Processing failed' });
            }

            try {
                console.log('Uploading to R2...');
                const uploadResult = await uploadVideoToR2(`${workDir}/output.mp4`);
                console.log('Upload successful:', uploadResult.url);
                
                removeDir(workDir);
                
                res.json({
                    success: true,
                    url: uploadResult.url,
                    duration: audioDuration
                });
            } catch (uploadError) {
                console.error('Upload error:', uploadError);
                removeDir(workDir);
                res.status(500).json({ error: 'Upload failed', details: uploadError.message });
            }
        });

    } catch (error) {
        console.error('Error:', error);
        removeDir(workDir);
        res.status(500).json({ error: 'Processing failed', details: error.message });
    }
});

app.get('/', (req, res) => {
    res.json({ status: 'Mixer service v8 - returns R2 URL + duration' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
