import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import cron from 'node-cron';
import ollama from 'ollama';

const NOTIFICATIONS_CONFIG_PATH = 'notifications.json';
const SENT_HISTORY_PATH = 'sent_history.json';
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.heic', '.heif'];
const HEIC_EXTENSIONS = ['.heic', '.heif'];

// --- CSV parsing ---

function loadNotes(csvPath) {
    let content;
    try {
        content = fs.readFileSync(csvPath, 'utf-8');
    } catch {
        return {};
    }

    // Strip BOM and normalize line endings
    content = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

    const lines = content.trim().split('\n');
    const notes = {};

    // Skip header row
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const firstComma = line.indexOf(',');
        if (firstComma === -1) continue;

        const filename = line.substring(0, firstComma).trim().replace(/^"|"$/g, '');
        let note = line.substring(firstComma + 1).trim();
        // Strip surrounding quotes
        if (note.startsWith('"') && note.endsWith('"')) {
            note = note.slice(1, -1).replace(/""/g, '"');
        }
        notes[filename] = note;
    }
    return notes;
}

// --- EXIF extraction via ImageMagick ---

function parseGpsRational(str) {
    const parts = str.split(',').map(p => {
        const [num, den] = p.trim().split('/').map(Number);
        return den ? num / den : num;
    });
    if (parts.length !== 3) return null;
    return parts[0] + parts[1] / 60 + parts[2] / 3600;
}

function getExifData(imagePath) {
    let output;
    try {
        output = execSync(`identify -verbose "${imagePath}" 2>/dev/null`, {
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024,
        });
    } catch {
        try {
            output = execSync(`magick identify -verbose "${imagePath}" 2>/dev/null`, {
                encoding: 'utf-8',
                maxBuffer: 1024 * 1024,
            });
        } catch {
            return {};
        }
    }

    const exif = {};
    for (const line of output.split('\n')) {
        const trimmed = line.trim();

        if (trimmed.startsWith('exif:DateTimeOriginal:')) {
            exif.dateTaken = trimmed.split(':').slice(1).join(':').trim();
        } else if (trimmed.startsWith('exif:DateTime:') && !exif.dateTaken) {
            exif.dateTaken = trimmed.split(':').slice(1).join(':').trim();
        } else if (trimmed.startsWith('exif:GPSLatitude:')) {
            exif._gpsLatRaw = trimmed.substring('exif:GPSLatitude:'.length).trim();
        } else if (trimmed.startsWith('exif:GPSLatitudeRef:')) {
            exif._gpsLatRef = trimmed.substring('exif:GPSLatitudeRef:'.length).trim();
        } else if (trimmed.startsWith('exif:GPSLongitude:')) {
            exif._gpsLonRaw = trimmed.substring('exif:GPSLongitude:'.length).trim();
        } else if (trimmed.startsWith('exif:GPSLongitudeRef:')) {
            exif._gpsLonRef = trimmed.substring('exif:GPSLongitudeRef:'.length).trim();
        } else if (trimmed.startsWith('exif:Make:')) {
            exif.cameraMake = trimmed.substring('exif:Make:'.length).trim();
        } else if (trimmed.startsWith('exif:Model:')) {
            exif.cameraModel = trimmed.substring('exif:Model:'.length).trim();
        }
    }

    // Convert GPS to decimal coordinates
    if (exif._gpsLatRaw && exif._gpsLatRef) {
        const lat = parseGpsRational(exif._gpsLatRaw);
        if (lat !== null) {
            exif.latitude = exif._gpsLatRef === 'S' ? -lat : lat;
        }
    }
    if (exif._gpsLonRaw && exif._gpsLonRef) {
        const lon = parseGpsRational(exif._gpsLonRaw);
        if (lon !== null) {
            exif.longitude = exif._gpsLonRef === 'W' ? -lon : lon;
        }
    }

    // Clean up internal fields
    delete exif._gpsLatRaw;
    delete exif._gpsLatRef;
    delete exif._gpsLonRaw;
    delete exif._gpsLonRef;

    return exif;
}

// --- HEIC to JPEG conversion ---

function convertHeicToJpeg(imagePath) {
    const ext = path.extname(imagePath).toLowerCase();
    if (!HEIC_EXTENSIONS.includes(ext)) return imagePath;

    const jpegPath = imagePath.replace(/\.[^.]+$/, '.jpg');
    if (fs.existsSync(jpegPath)) return jpegPath;
    try {
        execSync(`magick "${imagePath}" "${jpegPath}" 2>/dev/null`);
    } catch {
        execSync(`convert "${imagePath}" "${jpegPath}"`);
    }
    return jpegPath;
}

// --- Sent history tracking ---

function loadSentHistory() {
    try {
        return JSON.parse(fs.readFileSync(SENT_HISTORY_PATH, 'utf-8'));
    } catch {
        return {};
    }
}

function saveSentHistory(history) {
    fs.writeFileSync(SENT_HISTORY_PATH, JSON.stringify(history, null, 2));
}

// --- Image selection ---

function pickRandomImage(folder, notificationName) {
    const history = loadSentHistory();
    const sent = history[notificationName] || [];

    const allImages = fs.readdirSync(folder).filter(f =>
        IMAGE_EXTENSIONS.includes(path.extname(f).toLowerCase())
    );

    let available = allImages.filter(f => !sent.includes(f));

    // All images sent — reset the cycle
    if (available.length === 0) {
        history[notificationName] = [];
        available = allImages;
    }

    if (available.length === 0) return null;

    const picked = available[Math.floor(Math.random() * available.length)];

    // Record as sent
    if (!history[notificationName]) history[notificationName] = [];
    history[notificationName].push(picked);
    saveSentHistory(history);

    return picked;
}

// --- Vision model description ---

async function generateDescription(imagePath, notes, exifData, model) {
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');

    let prompt = 'Write an engaging, informative paragraph for a Discord post describing this photo.';

    if (notes) {
        prompt += `\n\nNotes about this photo: ${notes}`;
    }

    const exifParts = [];
    if (exifData.dateTaken) exifParts.push(`Date taken: ${exifData.dateTaken}`);
    if (exifData.latitude != null && exifData.longitude != null) {
        exifParts.push(`GPS coordinates: ${exifData.latitude.toFixed(5)}, ${exifData.longitude.toFixed(5)}`);
    }
    if (exifData.cameraMake || exifData.cameraModel) {
        exifParts.push(`Camera: ${[exifData.cameraMake, exifData.cameraModel].filter(Boolean).join(' ')}`);
    }
    if (exifParts.length > 0) {
        prompt += `\n\nPhoto metadata:\n${exifParts.join('\n')}`;
    }

    prompt += '\n\nCombine what you see in the image with the notes and metadata to create a vivid, interesting description. If GPS coordinates are available, mention the general location. Keep it to one paragraph.';

    const response = await ollama.chat({
        model: model,
        messages: [{
            role: 'user',
            content: prompt,
            images: [base64Image],
        }],
    });

    return String(response.message?.content ?? '').trim();
}

// --- Main notification execution ---

async function executeNotification(notification, client) {
    const { name, folder, channelId, notesFile, model } = notification;

    const channel = await client.channels.fetch(channelId);
    if (!channel) {
        console.error(`[notifications] Channel ${channelId} not found for "${name}"`);
        return;
    }

    const filename = pickRandomImage(folder, name);
    if (!filename) {
        console.log(`[notifications] No images in ${folder} for "${name}"`);
        return;
    }

    const imagePath = path.join(folder, filename);
    console.log(`[notifications] "${name}": selected ${filename}`);

    // Load notes from CSV
    const csvPath = path.join(folder, notesFile || 'notes.csv');
    const allNotes = loadNotes(csvPath);
    const notes = allNotes[filename] || '';

    // Extract EXIF metadata before any conversion (conversion can strip it)
    const exifData = getExifData(imagePath);

    // Convert HEIC to JPEG if needed
    const sendPath = convertHeicToJpeg(imagePath);

    // Generate description with vision model
    const description = await generateDescription(
        sendPath,
        notes,
        exifData,
        model || 'qwen3-vl-10k',
    );

    // Send to Discord
    await channel.send({
        content: description,
        files: [sendPath],
    });

    console.log(`[notifications] "${name}": sent ${filename} to channel ${channelId}`);
}

// --- Scheduling ---

export function initNotifications(client) {
    let config;
    try {
        config = JSON.parse(fs.readFileSync(NOTIFICATIONS_CONFIG_PATH, 'utf-8'));
    } catch {
        console.log('[notifications] No notifications.json found, skipping');
        return;
    }

    if (!Array.isArray(config) || config.length === 0) {
        console.log('[notifications] No notifications configured');
        return;
    }

    for (const notification of config) {
        const { name, time } = notification;
        const [hour, minute] = (time || '12:00').split(':');
        const cronExpr = `${parseInt(minute)} ${parseInt(hour)} * * *`;

        cron.schedule(cronExpr, async () => {
            console.log(`[notifications] Firing "${name}"...`);
            try {
                await executeNotification(notification, client);
            } catch (err) {
                console.error(`[notifications] Error in "${name}":`, err);
            }
        });

        console.log(`[notifications] Scheduled "${name}" at ${time} daily`);
    }
}
