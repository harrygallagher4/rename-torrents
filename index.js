import fs from 'fs';
import path from 'path';
import TorrentLibrary from 'torrent-files-library';
import MovieDB from 'moviedb';
import TVDB from 'node-tvdb';
import moment from 'moment';
import ptn from 'torrent-name-parser';
import request from 'request';

const CONFIG = require('./config.json');

const { TMDB_API_KEY, TVDB_API_KEY, PUSHBULLET_API_KEY } = CONFIG.AUTH;
const { PUSHBULLET, BLACKLIST } = CONFIG;
const { MOVIE_PATH, TV_PATH, NEW_PATH } = CONFIG.PATHS;
const BLACKLIST_NAMES = BLACKLIST.NAMES;
const BLACKLIST_DELETE = BLACKLIST.DELETE_FILES;

const tmdb = MovieDB(TMDB_API_KEY);
const tvdb = new TVDB(TVDB_API_KEY);
const tl = new TorrentLibrary();


tl.addNewPath(NEW_PATH)
    .then(message => {
        scanAndMove();
        watch();
    })
    .catch(error => {
        console.log(error);
    });

function watch() {
    fs.watch(NEW_PATH, (type, file) => {
        console.log(`Detected change ${type} ${file}, scanning...`);
        scanAndMove();
    });
}

function handleBlacklisting(torrent, file) {
    if (BLACKLIST_NAMES.includes(torrent.title.toLowerCase())) {
        if (BLACKLIST_DELETE) {
            console.log(`[BLACKLIST] DELETING FILE: ${file}`);
            try {
                if (fs.existsSync(file)) {
                    fs.unlinkSync(file);
                }
            } catch (e) {
                console.log(`[BLACKLIST] there was an error deleting ${file}`);
                console.log(e);
            }
        } else {
            console.log(`[BLACKLIST] Ignoring file: ${file}`);
            console.log(`[BLACKLIST] If this is an error, remove '${torrent.title.toLowerCase()}' from BLACKLIST_NAMES`);
        }
        return true;
    }
    return false;
}

function fileInfo(file) {
    const torrent = ptn(path.basename(file));
    const dir = path.dirname(file);
    const ext = path.extname(file);
    const parentDir = path.dirname(dir);

    return { torrent, dir, ext, parentDir };
}

function tmdbDestination(match, extension) {
    const year = tmdbMatchYear(match);
    const name = movieName({ title: match.title, year: year });
    const folder = movieFolder(name);
    const path = moviePath(folder, name, extension);

    return { year, name, folder, path };
}

function tmdbMatchYear(match) {
    return moment(match.release_date).toObject().years;
}

function movieName({ title, year }) {
    return `${title} (${year})`;
}

function movieFolder(name) {
    return `${MOVIE_PATH}/${name}`;
}

function moviePath(folder, name, extension) {
    return `${folder}/${name}${extension}`;
}

function processMovie(file) {

    const info = fileInfo(file);
    const { torrent, dir, ext, parentDir } = info;

    if (handleBlacklisting(torrent, file)) {
        return;
    }

    tmdb.searchMovie({
        query: torrent.title,
        year: torrent.year
    }, (e, r) => {
        if (e || !r || !r.results || !r.results[0]) {
            console.log(`NO MATCH! ${torrent.title}`);
            return;
        }

        const match = r.results[0];

        const destination = tmdbDestination(match, ext);
        const { year, name, folder, path } = destination;

        try {
            if (!fs.existsSync(folder)) {
                fs.mkdirSync(folder);
            }

            console.log(`[MOVIES]: MOVING:\t${file} => ${path}`);
            fs.rename(file, path, e => { console.log(e); });
            tl.removeOldFiles(file);

            const options = {
                headers: {
                    'Access-Token': PUSHBULLET_API_KEY
                },
                uri: 'https://api.pushbullet.com/v2/pushes',
                method: 'POST',
                json: {
                    'channel_tag': `${PUSHBULLET.CHANNEL_TAG}`,
                    'type': 'note',
                    'title': `${PUSHBULLET.SERVER_NAME} - ${name}`,
                    'body': `${name} was added to ${PUSHBULLET.SERVER_NAME}`
                }
            };

            request(options, (e, r, b) => {
                console.log(e, b);
            });

        } catch (e) {
            console.error(e);
        }
    });
}

function tvSeriesPath(torrent) {
    return `${TV_PATH}/${torrent.title}`;
}

function tvSeasonPath(seriesPath, torrent) {
    return `${seriesPath}/Season ${torrent.season}`;
}

function tvEpisodePath(seasonPath, torrent, ext) {
    return `${seasonPath}/${torrent.title} S${torrent.season}E${torrent.episode}${ext}`;
}

function tvShowDestination(torrent, ext) {
    const seriesPath = tvSeriesPath(torrent);
    const seasonPath = tvSeasonPath(seriesPath, torrent);
    const episodePath = tvEpisodePath(seasonPath, torrent, ext);

    return { seriesPath, seasonPath, episodePath };
}

function processTV(file) {

    const info = fileInfo(file);
    const { torrent, dir, ext, parentDir } = info;

    if (handleBlacklisting(torrent, file)) {
        return;
    }

    const destination = tvShowDestination(torrent, ext);
    const { seriesPath, seasonPath, episodePath } = destination;

    try {
        if (!fs.existsSync(seriesPath)) {
            console.log(`Series path ${seriesPath} does not exist, creating...`);
            fs.mkdirSync(seriesPath);
        }

        if (!fs.existsSync(seasonPath)) {
            console.log(`Season path ${seasonPath} does not exist, creating...`);
            fs.mkdirSync(seasonPath);
        }

        console.log(`[TV SHOWS] MOVING:\t${file} => ${episodePath}`);
        fs.rename(file, episodePath, e => { console.log(e); });
        tl.removeOldFiles(file);

        const options = {
            headers: {
                'Access-Token': PUSHBULLET_API_KEY
            },
            uri: 'https://api.pushbullet.com/v2/pushes',
            method: 'POST',
            json: {
                'channel_tag': `${PUSHBULLET.CHANNEL_TAG}`,
                'type': 'note',
                'title': `${PUSHBULLET.SERVER_NAME} - ${torrent.title}`,
                'body': `An episode of ${torrent.title} was added to ${PUSHBULLET.SERVER_NAME}`
            }
        };

        request(options, (e, r, b) => {
            console.log(e, b);
        });

    } catch (e) {
        console.error(e);
    }

}

function scanAndMove() {
    tl.scan()
        .then(message => {
            tl.allFilesWithCategory.forEach((type, file) => {
                if (!fs.existsSync(file)) {
                    console.log(`Skipping: ${file}`);
                    return;
                }

                if (type == 'MOVIES') {
                    //TODO this is a hack
                    if (file.toLowerCase().includes('sample')) {
                        console.log(`[MOVIES] Detected sample file, deleting: ${file}`);
                        try {
                            fs.unlinkSync(file);
                        } catch (e) {
                            console.log(e);
                        }

                        return;
                    }

                    console.log(`[MOVIES] Processing: ${file}`);
                    processMovie(file);
                } else if (type == 'TV_SERIES') {
                    console.log(`[TV] Processing: ${file}`);
                    processTV(file);
                } else {
                    console.log(`[${type}] Unknown type, ignoring: ${file}`);
                }
            });
        })
        .catch(error => {
            console.log('ERROR:');
            console.log(error);
        });
}
