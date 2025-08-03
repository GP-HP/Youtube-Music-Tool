#!/usr/bin/env node
const inquirer = require('inquirer');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { execSync, exec: execCallback } = require('child_process');
const { promisify } = require('util');
const os = require('os');
const cheerio = require('cheerio');
const ora = require('ora');

const exec = promisify(execCallback);
const isPkg = typeof process.pkg !== 'undefined';
const appRoot = isPkg ? path.dirname(process.execPath) : __dirname;

let downloadDir = path.join(appRoot, 'Downloads');

const YTDLP_PATH = path.join(appRoot, 'yt-dlp.exe');
const FFMPEG_PATH = path.join(appRoot, 'ffmpeg.exe');
const FFPROBE_PATH = path.join(appRoot, 'ffprobe.exe');

process.env.FFMPEG_LOCATION = FFMPEG_PATH;
process.env.FFPROBE_LOCATION = FFPROBE_PATH;

function openInBrowser(url) {
  if (os.platform() === 'win32') exec(`start "" "${url}"`);
  else if (os.platform() === 'darwin') exec(`open "${url}"`);
  else exec(`xdg-open "${url}"`);
}

function formatSize(bytes) {
  if (bytes === 0) return 'N/A';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ['B', 'KB', 'MB', 'GB'][i];
}

function safeFilename(name) {
  return name.replace(/[<>:"/\|?*\x00-\x1F]/g, '').trim();
}

function cleanTitle(title) {
  return title
    .replace(/\(.*?\)/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/["']/g, '')
    .replace(/\s*[:-]\s*/g, ' ')
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanArtist(artist) {
  return artist
    .replace(/,|&|feat\.?|ft\.?|by|official|audio|video/gi, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function runYtDlpCommand(args, options = {}) {
  const cmd = `"${YTDLP_PATH}" ${args}`;
  return execSync(cmd, { encoding: 'utf8', ...options });
}

async function setupDownloadPath() {
  if (!fs.existsSync(downloadDir)) {
    const { custom } = await inquirer.prompt({
      type: 'confirm',
      name: 'custom',
      message: `Use default download path: ${downloadDir}?`,
      default: true,
    });
    if (!custom) {
      const { customPath } = await inquirer.prompt({
        type: 'input',
        name: 'customPath',
        message: 'Enter your custom download directory:',
        default: downloadDir,
      });
      downloadDir = customPath;
    }
    fs.mkdirSync(downloadDir, { recursive: true });
  }
}



async function fetchMetadata(url, isMusicDomain = false) {

  if (url.includes('music.youtube.com')) {
    url = url.replace('music.youtube.com', 'www.youtube.com');
  }

  const isPlaylist = url.includes('list=');
  if (isPlaylist) {
    const stdout = runYtDlpCommand(`--flat-playlist --dump-json "${url}"`);
    const lines = stdout.trim().split('\n');
    const tracks = lines.map(line => JSON.parse(line));
    const useMusicSubdomain = url.includes('music.youtube.com');

const domain = isMusicDomain ? 'music.youtube.com' : 'www.youtube.com';
const detailedTracks = tracks.map(track => ({
  id: track.id,
  url: `https://${domain}/watch?v=${track.id}`,
  title: track.title,
  artist: track.uploader || '',
}));


    return { isPlaylist: true, tracks: detailedTracks };
  } else {
    const info = JSON.parse(runYtDlpCommand(`--no-warnings --print-json --skip-download "${url}"`));
    return {
      isPlaylist: false,
      title: info.title,
      duration: info.duration_string || `${Math.floor(info.duration / 60)}:${info.duration % 60}`,
      artist: info.artist || info.uploader,
      thumbnail: info.thumbnail,
      formats: info.formats
  .map(f => ({
    itag: f.format_id,
    ext: f.ext,
    acodec: f.acodec,
    abr: f.abr,
    filesize: f.filesize_approx || f.filesize || 0,
    formatNote: f.format_note,
    url: f.url
  }))
  .filter(f => f.acodec !== 'none')


    };
  }
}

async function tryFetchFromGenius(query) {
  try {
    const searchUrl = `https://genius.com/search?q=${encodeURIComponent(query)}`;
    const searchRes = await fetch(searchUrl);
    const searchHtml = await searchRes.text();
    const $ = cheerio.load(searchHtml);
    const firstLink = $('a[href^="https://genius.com"]').attr('href');
    if (!firstLink) return null;
    const songPageRes = await fetch(firstLink);
    const songHtml = await songPageRes.text();
    const $$ = cheerio.load(songHtml);
    return $$('.lyrics').text().trim() || $$('[data-lyrics-container]').text().trim() || null;
  } catch (_) {
    return null;
  }
}

async function fetchLyrics(title, artist) {
  if (!artist || artist.trim() === '') {
    console.warn(`⚠️ Warning: No artist metadata found for "${title}"`);
  }
  const titleVariants = Array.from(new Set([
    cleanTitle(title),
    title.replace(/\(.*?\)/g, '').trim(),
    title.replace(/["']/g, '').trim(),
    title.replace(/[^a-zA-Z0-9\s]/g, '').trim(),
    title.trim()
  ]));

  const rawArtist = artist.trim();
  const tokens = rawArtist
    .split(/,|&|feat\.?|ft\.?|by|official|audio|video/gi)
    .map(a => a.trim())
    .filter(Boolean);

  const individual = tokens;
  const original = tokens;
  const reversed = [...tokens].reverse();

  const artistVariants = Array.from(new Set([
    ...individual,
    original.join(', '),
    original.join('  '),
    original.join(' '),
    original.join(''),
    reversed.join(', '),
    reversed.join('  '),
    reversed.join(' '),
    reversed.join(''),
    artist.split(' ').join(', '),
    artist.split(' ').reverse().join(', '),
    cleanArtist(rawArtist),
  ]));

  const tried = new Set();

  for (const t of titleVariants) {
    for (const a of artistVariants) {
      const key = `${t.toLowerCase()}|${a.toLowerCase()}`;
      if (tried.has(key)) continue;
      tried.add(key);

      const queryURL = `https://lrclib.net/api/search?track_name=${encodeURIComponent(t)}&artist_name=${encodeURIComponent(a)}`;
      console.log(`🔍 Trying lrclib: "${t}" by "${a}"`);

      try {
        const res = await fetch(queryURL);
        if (!res.ok || !res.headers.get("content-type")?.includes("application/json")) continue;
        const data = await res.json();
        const hit = data.find(entry => entry.syncedLyrics || entry.plainLyrics);
        if (hit) {
          const lyrics = hit.syncedLyrics || `[UNSYNCED LYRICS]\n\n${hit.plainLyrics}`;
          console.log(`✅ Found on lrclib: "${t}" by "${a}"`);
          return lyrics;
        }
      } catch (err) {
        console.error(`⚠️ lrclib error: ${err.message}`);
      }
    }
  }

  for (const t of titleVariants) {
    for (const a of artistVariants) {
      console.log(`🎯 Trying Genius: "${t}" by "${a}"`);
      const lyrics = await tryFetchFromGenius(`${t} ${a}`);
      if (lyrics) {
        console.log(`✅ Found on Genius: "${t}" by "${a}"`);
        return lyrics;
      }
    }
  }

  console.log(`❌ No lyrics found for "${title}" by "${artist}"`);
  return null;
}

function saveLyrics(title, lyrics) {
  const isSynced = lyrics.includes('[');
  const ext = isSynced ? '.lrc' : '.txt';
  const filename = path.join(downloadDir, `${safeFilename(title)}${ext}`);
  fs.writeFileSync(filename, lyrics);
}

function addToFavourites(title, url) {
  const favPath = path.join(appRoot, 'favourites.txt');
  if (!fs.existsSync(favPath)) fs.writeFileSync(favPath, '');
  fs.appendFileSync(favPath, `${title} | ${url}\n`);
}

async function main() {
  console.clear();
  console.log(`\n=============================================================`);
  console.log(`     🎶  YouTube Music Playlist Tool`);
  console.log(`=============================================================\n`);

  await setupDownloadPath();

  const { url } = await inquirer.prompt({
    type: 'input',
    name: 'url',
    message: '🎵 Enter YouTube Music/Playlist URL:',
  });
  const originalUrl = url;
const isMusicDomain = originalUrl.includes('music.youtube.com');

  console.log('🔎 Fetching metadata...');
  const meta = await fetchMetadata(url, isMusicDomain);


 if (!meta.isPlaylist) {
  console.log(`\n📀 Title: ${meta.title}`);
  console.log(`🎤 Artist: ${meta.artist}`);
  console.log(`⏱ Duration: ${meta.duration}`);
  console.log(`🖼 Thumbnail: ${meta.thumbnail}\n`);

  const { action } = await inquirer.prompt({
    type: 'list',
    name: 'action',
    message: '📥 Choose action:',
    choices: [
      '🎵 Download Now',
      '🌐 Open in Browser',
      '⭐ Add to Favourites',
      '📜 Fetch Lyrics'
    ]
  });

  if (action === '⭐ Add to Favourites') {
    addToFavourites(meta.title, url);
    console.log('⭐ Added to favourites!');
  } else if (action === '📜 Fetch Lyrics') {
    const lyrics = await fetchLyrics(meta.title, meta.artist);
    if (lyrics) {
      saveLyrics(meta.title, lyrics);
      console.log('📜 Lyrics downloaded.');
    } else {
      console.log('❌ Lyrics not found.');
    }

  } else if (action === '🌐 Open in Browser') {
    const { openType } = await inquirer.prompt({
      type: 'list',
      name: 'openType',
      message: '🌍 Choose how to open:',
      choices: [
        { name: '📺 Open YouTube Page', value: 'page' },
        { name: '🔗 Open Direct Audio/Video Link', value: 'direct' }
      ]
    });

    if (openType === 'page') {
      openInBrowser(url);
    } else {
      const detailedMeta = await fetchMetadata(url); // fetch full formats
      const formats = detailedMeta.formats.filter(f => f.url);
      const choices = formats.map((format, index) => {
        const codec = format.acodec || 'unknown codec';
        const bitrate = format.abr ? `${format.abr}kbps` : 'unknown bitrate';
        const ext = format.ext || format.container || 'unknown';
        const size = format.filesize ? formatSize(format.filesize) : 'unknown size';

        return {
          name: `${index + 1}. ${codec} - ${bitrate} - ${ext} - ${size}`,
          value: format.url
        };
      });

      const { selectedFormatUrl } = await inquirer.prompt({
        type: 'list',
        name: 'selectedFormatUrl',
        message: `🎵 Select format to play "${detailedMeta.title}":`,
        choices
      });

      openInBrowser(selectedFormatUrl);
    }

  } else if (action === '🎵 Download Now') {
    const formatChoices = meta.formats.map(f => ({
      name: `${f.itag} | ${f.ext} | ${f.acodec} | ${f.abr || '?'}kbps | ${formatSize(f.filesize)}`,
      value: f.itag
    }));

    const { format } = await inquirer.prompt({
      type: 'list',
      name: 'format',
      message: '🎧 Choose format:',
      choices: formatChoices
    });

    const selectedFormat = meta.formats.find(f => f.itag === format);
    const shouldEmbed = ['mp3', 'm4a', 'mp4', 'mkv', 'mka', 'ogg', 'opus', 'flac', 'mov', 'm4v'].includes(selectedFormat.ext.toLowerCase());

    const filename = `${safeFilename(meta.title)}.%(ext)s`;
    const output = path.join(downloadDir, filename);
    const embedFlags = shouldEmbed ? '--write-thumbnail --embed-thumbnail --embed-metadata --metadata-from-title "%{title}"' : '';
    const spinner = ora(`🎶 Downloading: ${meta.title}`).start();

    try {
      execSync(
        `"${YTDLP_PATH}" -f ${format} -o "${output}" --ffmpeg-location "${FFMPEG_PATH}" ${embedFlags} "${url}"`,
        { stdio: 'ignore' }
      );
      spinner.succeed('✅ Download complete!');
    } catch (err) {
      spinner.fail('❌ Download failed.');
    }
  }
}

 else {
  const { selectedIndexes } = await inquirer.prompt({
    type: 'checkbox',
    name: 'selectedIndexes',
    message: '🎵 Select tracks to operate on:',
    choices: meta.tracks.map((track, idx) => ({ name: track.title, value: idx })),
    pageSize: 20
  });

  const { playlistAction } = await inquirer.prompt({
    type: 'list',
    name: 'playlistAction',
    message: '📥 Choose action for selected tracks:',
    choices: ['🎵 Download Now', '🌐 Open in Browser', '⭐ Add to Favourites', '📜 Fetch Lyrics']
  });

  for (const idx of selectedIndexes) {
    const track = meta.tracks[idx];
    const detailedMeta = await fetchMetadata(track.url);
 console.log(`\n📀 Title: ${detailedMeta.title}`);
  console.log(`🎤 Artist: ${detailedMeta.artist || 'Unknown'}`);
  console.log(`⏱ Duration: ${detailedMeta.duration || 'Unknown'}`);
  console.log(`🖼 Thumbnail: ${detailedMeta.thumbnail || 'N/A'}\n`);

    if (playlistAction === '🎵 Download Now') {
      const audioFormats = detailedMeta.formats.filter(f => f.acodec !== 'none' && f.filesize);

      if (!audioFormats.length) {
        console.log(`⚠️ No downloadable audio formats found for "${detailedMeta.title}"`);
        continue;
      }

      const formatChoices = audioFormats.map((f, i) => ({
        name: `${i + 1}. ${f.ext} | ${f.acodec} | ${f.abr || 'N/A'} kbps | ${formatSize(f.filesize)}`,
        value: f.itag
      }));

      const { selectedFormat } = await inquirer.prompt({
        type: 'list',
        name: 'selectedFormat',
        message: `🎧 Select format for: ${detailedMeta.title}`,
        choices: formatChoices
      });

      const selected = detailedMeta.formats.find(f => f.itag === selectedFormat);
      const shouldEmbed = ['mp3', 'm4a', 'mp4', 'mkv', 'mka', 'ogg', 'opus', 'flac', 'mov', 'm4v'].includes(selected.ext.toLowerCase());

      const filename = `${safeFilename(detailedMeta.title)}.%(ext)s`;
      const output = path.join(downloadDir, filename);
      const embedFlags = shouldEmbed ? '--write-thumbnail --embed-thumbnail --embed-metadata --metadata-from-title "%{title}"' : '';
      const spinner = ora(`🎶 Downloading: ${detailedMeta.title}`).start();

      try {
        execSync(`${YTDLP_PATH} -f ${selectedFormat} -o "${output}" --ffmpeg-location "${FFMPEG_PATH}" ${embedFlags} "${track.url}"`, { stdio: 'ignore' });
        spinner.succeed(`✅ Downloaded: ${detailedMeta.title}`);
      } catch (err) {
        spinner.fail(`❌ Failed: ${detailedMeta.title}`);
      }

    } else if (playlistAction === '📜 Fetch Lyrics') {
      const lyrics = await fetchLyrics(detailedMeta.title, detailedMeta.artist);
      if (lyrics) {
        saveLyrics(detailedMeta.title, lyrics);
        console.log(`📜 Lyrics downloaded: ${detailedMeta.title}`);
      } else {
        console.log(`❌ Lyrics not found: ${detailedMeta.title}`);
      }

    } else if (playlistAction === '⭐ Add to Favourites') {
      addToFavourites(detailedMeta.title, track.url);
      console.log(`⭐ Added to favourites: ${detailedMeta.title}`);

    } else if (playlistAction === '🌐 Open in Browser') {
      const { openType } = await inquirer.prompt({
        type: 'list',
        name: 'openType',
        message: `🌍 How to open "${detailedMeta.title}"?`,
        choices: [
          { name: '📺 Open YouTube Page', value: 'page' },
          { name: '🔗 Open Direct Audio/Video Link', value: 'direct' },
          { name: '⏭️ Skip this video', value: 'skip' }
        ]
      });

      if (openType === 'skip') continue;

      if (openType === 'page') {
        openInBrowser(track.url);
      } else {
        const formats = detailedMeta.formats.filter(f => f.url);
        const choices = formats.map((format, index) => {
          const codec = format.acodec || 'unknown codec';
          const bitrate = format.abr ? `${format.abr}kbps` : format.qualityLabel || 'unknown';
          const ext = format.ext || format.container || 'unknown';
          const size = format.filesize ? formatSize(format.filesize) : 'unknown size';

          return {
            name: `${index + 1}. ${codec} - ${bitrate} - ${ext} - ${size}`,
            value: format.url
          };
        });

        const { selectedFormatUrl } = await inquirer.prompt({
          type: 'list',
          name: 'selectedFormatUrl',
          message: `🎵 Select format to play "${detailedMeta.title}":`,
          choices
        });

        openInBrowser(selectedFormatUrl);
      }
    }
  }
}
}
main();
