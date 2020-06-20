const debug = require("debug")("youka:desktop");
const rp = require("request-promise");
const library = require("./library");
const {
  Client,
  QUEUE_ALIGN,
  QUEUE_ALIGN_LINE,
  QUEUE_ALIGN_EN,
  QUEUE_SPLIT,
} = require("./client");
const retry = require("promise-retry");

const client = new Client();

async function generate(youtubeID, title, onStatus) {
  debug("youtube-id", youtubeID);

  onStatus("Initializing");
  await library.init(youtubeID);

  onStatus("Searching lyrics");
  const lyrics = await library.getLyrics(youtubeID, title);

  onStatus("Downloading audio");
  const originalAudio = await library.getAudio(
    youtubeID,
    library.MODE_MEDIA_ORIGINAL
  );

  onStatus("Uploading files");
  const audioUrl = await client.upload(originalAudio);

  let lang, transcriptUrl;
  if (lyrics) {
    lang = await library.getLanguage(youtubeID, lyrics);
    debug("lang", lang);
    transcriptUrl = await client.upload(lyrics);
  }

  const promises = [
    split(youtubeID, audioUrl, onStatus),
    library.getVideo(youtubeID, library.MODE_MEDIA_ORIGINAL),
    library.getInfo(youtubeID),
  ];
  if (lyrics && lang === "en") {
    promises.push(
      align(
        youtubeID,
        audioUrl,
        transcriptUrl,
        lang,
        library.MODE_CAPTIONS_WORD,
        onStatus
      )
    );
  }
  const [splitResult] = await Promise.all(promises);
  const vocalsUrl = splitResult.vocalsUrl;

  if (lyrics && lang && SUPPORTED_LANGS.includes(lang)) {
    const alignPromises = [
      align(
        youtubeID,
        vocalsUrl,
        transcriptUrl,
        lang,
        library.MODE_CAPTIONS_LINE,
        onStatus
      ),
    ];
    if (lang !== "en") {
      alignPromises.push(
        align(
          youtubeID,
          vocalsUrl,
          transcriptUrl,
          lang,
          library.MODE_CAPTIONS_WORD,
          onStatus
        )
      );
    }
    await Promise.all(alignPromises);
  }

  await library.getVideo(youtubeID, library.MODE_MEDIA_INSTRUMENTS);
  await library.getVideo(youtubeID, library.MODE_MEDIA_VOCALS);
}

async function alignline(youtubeID, onStatus) {
  const queue = QUEUE_ALIGN_LINE;
  const alignments = await library.getAlignments(
    youtubeID,
    library.MODE_CAPTIONS_LINE
  );
  if (!alignments || !alignments.length)
    throw new Error("Line level sync not found");

  const lang = await library.getLanguage(youtubeID);
  if (!lang) throw new Error("Can't detect language");

  const audio = await library.getAudio(youtubeID, library.MODE_MEDIA_VOCALS);
  if (!audio) throw new Error("Can't find vocals");
  onStatus("Uploading files");
  const audioUrl = await client.upload(audio);
  const alignmentsUrl = await client.upload(JSON.stringify(alignments));
  const jobId = await client.enqueue(queue, {
    audioUrl,
    alignmentsUrl,
    options: { lang },
  });
  const job = await client.wait(queue, jobId, onStatus);
  if (!job || !job.result || !job.result.alignmentsUrl)
    throw new Error("Sync failed");
  const wordAlignments = await rp({
    uri: job.result.alignmentsUrl,
    encoding: "utf-8",
  });
  await library.saveFile(
    youtubeID,
    library.MODE_CAPTIONS_WORD,
    library.FILE_JSON,
    wordAlignments
  );
}

async function realign(youtubeID, title, mode, onStatus) {
  const lyrics = await library.getLyrics(youtubeID, title);
  if (!lyrics) throw new Error("Lyrics is empty");
  const lang = await library.getLanguage(youtubeID, lyrics, true);
  if (!lang) throw new Error("Can't detect language");
  const audioMode =
    lang === "en" ? library.MODE_MEDIA_ORIGINAL : library.MODE_MEDIA_VOCALS;
  const queue = lang === "en" ? QUEUE_ALIGN_EN : QUEUE_ALIGN;
  const audio = await library.getAudio(youtubeID, audioMode);
  const audioUrl = await client.upload(audio);
  const transcriptUrl = await client.upload(lyrics);
  const jobId = await client.enqueue(queue, {
    audioUrl,
    transcriptUrl,
    options: { mode, lang },
  });
  const job = await client.wait(queue, jobId, onStatus);
  if (!job || !job.result || !job.result.alignmentsUrl)
    throw new Error("Sync failed");
  const alignments = await retry((r) =>
    rp({
      uri: job.result.alignmentsUrl,
      encoding: "utf-8",
    }).catch(r)
  );
  await library.saveFile(youtubeID, mode, library.FILE_JSON, alignments);
}

async function align(youtubeID, audioUrl, transcriptUrl, lang, mode, onStatus) {
  const queue =
    lang === "en" && mode === library.MODE_CAPTIONS_WORD
      ? QUEUE_ALIGN_EN
      : QUEUE_ALIGN;
  const jobId = await client.enqueue(queue, {
    audioUrl,
    transcriptUrl,
    options: { mode, lang },
  });
  const job = await client.wait(queue, jobId, onStatus);
  if (!job || !job.result || !job.result.alignmentsUrl) return;
  const alignments = await retry((r) =>
    rp({
      uri: job.result.alignmentsUrl,
      encoding: "utf-8",
    }).catch(r)
  );
  await library.saveFile(youtubeID, mode, library.FILE_JSON, alignments);
}

async function split(youtubeID, audioUrl, onStatus) {
  const splitJobId = await client.enqueue(QUEUE_SPLIT, { audioUrl });
  const job = await client.wait(QUEUE_SPLIT, splitJobId, onStatus);
  if (
    !job ||
    !job.result ||
    !job.result.instrumentsUrl ||
    !job.result.vocalsUrl
  )
    throw new Error("Processing failed");
  onStatus("Downloading files");
  const [vocals, instruments] = await Promise.all([
    retry((r) => rp({ uri: job.result.vocalsUrl, encoding: null }).catch(r)),
    retry((r) =>
      rp({
        uri: job.result.instrumentsUrl,
        encoding: null,
      }).catch(r)
    ),
  ]);
  await library.saveFile(
    youtubeID,
    library.MODE_MEDIA_INSTRUMENTS,
    library.FILE_M4A,
    instruments
  );
  await library.saveFile(
    youtubeID,
    library.MODE_MEDIA_VOCALS,
    library.FILE_M4A,
    vocals
  );

  return job.result;
}

const SUPPORTED_LANGS = [
  "af",
  "am",
  "an",
  "ar",
  "as",
  "az",
  "ba",
  "bg",
  "bn",
  "bpy",
  "bs",
  "ca",
  "cmn",
  "cs",
  "cy",
  "da",
  "de",
  "el",
  "en",
  "eo",
  "es",
  "et",
  "eu",
  "fa",
  "fi",
  "fr",
  "ga",
  "gd",
  "gn",
  "grc",
  "gu",
  "hak",
  "hi",
  "hr",
  "ht",
  "hu",
  "hy",
  "hyw",
  "ia",
  "id",
  "is",
  "it",
  "ja",
  "jbo",
  "ka",
  "kk",
  "kl",
  "kn",
  "ko",
  "kok",
  "ku",
  "ky",
  "la",
  "lfn",
  "lt",
  "lv",
  "mi",
  "mk",
  "ml",
  "mr",
  "ms",
  "mt",
  "my",
  "nb",
  "nci",
  "ne",
  "nl",
  "om",
  "or",
  "pa",
  "pap",
  "pl",
  "pt",
  "py",
  "quc",
  "ro",
  "ru",
  "sd",
  "shn",
  "si",
  "sk",
  "sl",
  "sq",
  "sr",
  "sv",
  "sw",
  "ta",
  "te",
  "tn",
  "tr",
  "tt",
  "ur",
  "uz",
  "vi",
  "yue",
  "zh",
];

module.exports = {
  generate,
  realign,
  alignline,
  SUPPORTED_LANGS,
};
