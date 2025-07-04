/*
    Netease Cloud Music Lyric Script for ESLyric
    
    Version: 0.7.1 
    Original Author: ohyeah & cimoc (Refactored by Gemini 2.5)

    - v0.7.1 Fix: Override the 'NMTID' cookie which will cause the search endpoint return irrelevant data
    - v0.7.0 Fix: Uses the original track metadata (meta.rawTitle, meta.rawArtist)
      when creating the final lyric object. This ensures ESLyric always accepts
      the result, solving cases where API titles (e.g., with "feat.") differ
      from local file tags.
*/

evalLib('querystring/querystring.min.js');

const SEARCH_LIMIT = 15;

const doRequest = (method, url, data, options) => {
    return new Promise((resolve, reject) => {
        let headers = {
            'Referer': 'https://music.163.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/84.0.4147.89 Safari/537.36',
            'Cookie': 'NMTID='
        };
        let body = '';

        if (method.toUpperCase() === 'POST') {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }

        if (options.crypto === 'webapi') {
            headers['Host'] = 'music.163.com';
            body = querystring.stringify(data);
        } else {
            reject(new Error('Unsupported crypto type'));
            return;
        }

        const settings = {
            method: method,
            url: url,
            headers: headers,
            body: body
        };

        request(settings, (err, res, body) => {
            if (!err && res.statusCode === 200) {
                resolve(body);
            } else {
                const errorInfo = `Request failed: Status ${res ? res.statusCode : 'N/A'}. Error: ${err}`;
                reject(err || new Error(errorInfo));
            }
        });
    });
}

const procKeywords = (str) => {
    if (!str) return '';
    let s = str.toLowerCase();
    s = s.replace(/[\'·$&–\[\]\{\}《》「」『』]/g, " ");
    // s = s.replace(/\(.*?\)|（.*?）/g, "");
    s = s.replace(/[-/:-@[-`{-~]+/g, " ");
    s = s.replace(/[\u2014\u2018\u201c\u2026\u3001\u3002\u300a\u300b\u300e\u300f\u3010\u3011\u30fb\uff01\uff08\uff09\uff0c\uff1a\uff1b\uff1f\uff5e\uffe5]+/g, "");
    return s.trim().replace(/\s+/g, ' ');
}

export function getConfig(cfg)
{
    cfg.name = "ESLTest";
    cfg.version = "0.1.4";
    cfg.author = "dream";
}

export function getLyrics(meta, man) {
    const title = procKeywords(meta.rawTitle);
    const artist = processArtistName(procKeywords(meta.rawArtist));
    if (!title) return;

    console.log(`[Debug] Cleaned search terms: title='${title}', artist='${artist}'`);

    performSearch(title, artist, true)
        .then(searchResults => {
            let bestMatch = findBestMatch(searchResults, title, artist);
            if (bestMatch) {
                return Promise.resolve(bestMatch);
            } else {
                console.log('[Info] Exact search did not yield a confident match. Trying fuzzy search...');
                return performSearch(title, artist, false).then(fuzzyResults => {
                    console.log('[Info] --- Candidates ---')
                    if (fuzzyResults) { console.log(fuzzyResults.map(r => `${r.id}: ${r.artists.map(a=>a.name).join('/')} - ${r.name}`).join('\n')); }
                    console.log('[Info] ------------------')
                    return findBestMatch(fuzzyResults, title, artist);
                });
            }
        })
        .then(finalBestMatch => {
            if (finalBestMatch) {
                console.log(`[Info] Found best match: "${finalBestMatch.name} - ${finalBestMatch.artists.map(a=>a.name).join('/')}" (ID: ${finalBestMatch.id})`);
                // *** THE KEY CHANGE IS HERE: Pass 'meta' object down ***
                fetchAndAddLyric(finalBestMatch, man, meta);
            } else {
                console.log('[Warn] No suitable match found after all search attempts.');
            }
        })
        .catch(error => {
            console.log("[Error] An error occurred in the main promise chain: " + error.message);
        });

    messageLoop(0);
}

function performSearch(title, artist, isExact) {
    const searchTerm = isExact && artist ? `${title} ${artist}` : title;
    const searchUrl = 'https://music.163.com/api/search/get/';
    const searchData = {
        s: searchTerm,
        type: 1,
        limit: SEARCH_LIMIT,
        offset: 0
    };

    return doRequest('POST', searchUrl, searchData, { crypto: 'webapi' })
        .then(body => {
            if (!body) return null;
            try {
                const result = JSON.parse(body);
                if (result.code === 200 && result.result && result.result.songs) {
                    return result.result.songs;
                }
                return null;
            } catch (e) {
                return null;
            }
        });
}

function findBestMatch(songs, title, artist) {
    if (!songs || songs.length === 0) return null;
    
    const scoredSongs = songs.map(song => {
        let score = 0;
        const resultTitle = procKeywords(song.name);

        if (resultTitle.includes(title)) {
            score += 80;
            if (resultTitle === title) score += 20;
        } else {
            console.log(`[Debug] findBestMatch: ${song.id} "${song.name}" scored 0 (title mismatch).`);
            return { song, score: 0 };
        }

        if (artist && song.artists && song.artists.length > 0) {
            const apiArtists = procKeywords(song.artists.map(a => a.name).join(' '));
            const userArtistWords = artist.split(' ');
            let matchedWords = 0;
            
            userArtistWords.forEach(word => {
                if (apiArtists.includes(word)) matchedWords++;
            });
            
            const artistScore = (matchedWords / userArtistWords.length) * 100;
            score += artistScore;
        }
        console.log(`[Debug] findBestMatch: ${song.id} "${song.name}" scored ${score}.`);
        return { song, score };
    });

    scoredSongs.sort((a, b) => b.score - a.score);
    const best = scoredSongs[0];
    
    if (best.score > 101) {
        return best.song;
    }
    
    return null;
}

/**
 * Fetches lyrics and adds them using the original track metadata for context.
 * @param {object} song - The best matching song object from the API.
 * @param {object} man - The ESLyric manager object.
 * @param {object} meta - The original metadata from ESLyric (meta.rawTitle, meta.rawArtist).
 */
function fetchAndAddLyric(song, man, meta) {
    const lyricUrl = `https://music.163.com/api/song/lyric?os=pc&id=${song.id}&lv=-1&kv=-1&tv=-1`;
    console.log(`[Debug] Fetching lyrics from: ${lyricUrl}`);

    doRequest('GET', lyricUrl, {}, { crypto: 'webapi' })
        .then(body => {
            if (!body) return;
            try {
                const lyricObj = JSON.parse(body);
                let lyricText = '';
                let hasLrc = lyricObj.lrc && lyricObj.lrc.lyric;
                let hasTlyric = lyricObj.tlyric && lyricObj.tlyric.lyric;

                if (hasLrc) {
                    lyricText = lyricObj.lrc.lyric;
                } else {
                    console.log("[Warn] No lyric.");
                    return;
                }

                // *** THE KEY CHANGE IS HERE: Use 'meta' for title and artist ***
                const originalLyric = man.createLyric();
                originalLyric.title = meta.rawTitle;     // Use original title
                originalLyric.artist = meta.rawArtist;   // Use original artist
                originalLyric.album = song.album ? song.album.name : ''; // Album from API is fine
                originalLyric.lyricText = lyricText;
                originalLyric.source = "网易云音乐 (原词)";
                man.addLyric(originalLyric);
                console.log("[Debug] Added original lyric.");

                if (hasTlyric) {
                    const combinedLyric = man.createLyric();
                    combinedLyric.title = meta.rawTitle;   // Use original title
                    combinedLyric.artist = meta.rawArtist; // Use original artist
                    combinedLyric.album = song.album ? song.album.name : '';
                    combinedLyric.lyricText = lyricText + '\n' + lyricObj.tlyric.lyric;
                    combinedLyric.source = "网易云音乐 (原词+翻译)";
                    man.addLyric(combinedLyric);
                    console.log("[Debug] Added combined (original + translation) lyric.");
                }
            } catch (e) {
                console.log(`[Error] Error parsing or adding lyric for song ID ${song.id}: ${e.message}`);
            }
        });
}

function processArtistName(input) {

  // Check if the artist name contains cv information, e.g. "赤城ユイナ(CV.春日さくら)"
  // Most of the time Netease uses cv name, not character name
  const cvRegex = /cv[\s\.。、]?([^)\]}]+)/i;
  // Check brackets, () or （）
  let match = input.match(/\(([^)]+)\)/);
  if (!match) {
    match = input.match(/（([^)]+)）/);
  }
 
  if (match) {
    const bracketContent = match[1];
    const cvMatch = bracketContent.match(cvRegex);
    if (cvMatch) {
      return cvMatch[1].trim();
    }
  }
  
  // Return original input if not mathcing rules above
  return input;
}