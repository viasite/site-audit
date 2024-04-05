import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const systemLocale = getDefaultLocale(); // should be before scrap-site (before lighthouse require)
import { program } from 'commander';
import config from './config.js';
import color from './color.js';
import os from 'os';
import expandHomedir from 'expand-home-dir';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));

const defaultDocs = [
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'pdf',
  'rar',
  'zip'];

const fieldsCustom = {};

const list = val => {
  return val ? val.split(',') : [];
};

/* const collect = (value, previous) => {
  const res = value.match(/(.*?)=(.*)/);
  const name = res[1];
  const extractor = res[2];
  return previous.concat([{name, extractor}]);
}; */

const fieldsCustomCollect = (value, previous) => {
  const res = value.match(/(.*?)=(.*)/);
  const name = res[1];
  const extractor = res[2];

  fieldsCustom[name] = extractor;
  return fieldsCustom;
};

function getConfigVal(name, def) {
  let val = undefined;
  // objects like 'influxdb.maxSendCount'
  if (name.includes('.')) {
    const parts = name.split('.');
    let conf = config;
    for (let part of parts) {
      conf = conf[part];
      if (conf === undefined) {
        conf = def;
        break;
      }
    }

    if (typeof conf === 'object') val = def;
    else val = conf;
  }

  else if (config[name] === undefined) val = def;
  else val = config[name];
  // console.log(`config: ${name}: `, val);
  return val;
}

function createDirIfNotExists(path) {
  const exists = fs.existsSync(path);
  if (exists && fs.statSync(path).isFile()) {
    throw new Error(`File exists, cannot save here: ${path}`);
    return false;
  }

  if (!exists) fs.mkdirSync(path, {recursive: true});

  return path;
}

// only ru and en, default en
function getDefaultLocale() {
  const locale = new Intl.DateTimeFormat().resolvedOptions().locale;
  // console.log('locale:', new Intl.DateTimeFormat().resolvedOptions())
  const map = {
    'en-US': 'en',
    'ru-RU': 'ru',
    'en': 'en',
    'ru': 'ru',
  };

  return map[locale] || 'en';
}


program.postParse = async () => {
  // lang
  if (!['en', 'fr', 'de', 'ru'].includes(program.lang)) program.lang = systemLocale;

  // --json when --upload
  if (program.upload) program.json = true;

  // no remove json when --no-json
  if (!program.json) program.removeJson = false;

  if (program.delay > 0 && program.concurrency !== 1) {
    console.log('Force set concurrency to 1, must be 1 when delay is set');
    program.concurrency = 1;
  }

  if (program.docsExtensions === undefined) {
    program.docsExtensions = getConfigVal('docsExtensions', defaultDocs);
  }

  if (program.preset === 'lighthouse' || program.preset === 'lighthouse-all') {
    program.lighthouse = true;
  }

  // c = 2, when lighthouse or screenshot -> c = 1
  if (program.concurrency === undefined) {
    program.concurrency = getConfigVal('concurrency', Math.min(10, os.cpus().length));
    if (config.maxConcurrency && program.concurrency > config.maxConcurrency) {
      program.concurrency = config.maxConcurrency;
    }
  }
  if (program.lighthouse) {
    program.concurrency = 1;
  }
  if (program.screenshot) {
    program.concurrency = 1;
  }

  if (program.concurrency > os.cpus().length) {
    program.concurrency = os.cpus().length;
  }

  if (program.urls) {
    if (program.urls.length > 1) program.urlList = true;
  }
  else program.urls = [];

  if (program.urlList) {
    program.maxDepth = 1;
    program.limitDomain = false;
    program.ignoreRobotsTxt = true;
    // program.defaultFilter = 'depth>1';
  }

  // influxdb config fron ~/.site-audit-seo.conf.js
  program.influxdb = getConfigVal('influxdb', false);
  if (program.influxdb && program.influxdbMaxSend) {
    program.influxdb.maxSendCount = program.influxdbMaxSend;
  }

  program.outDir = expandHomedir(program.outDir);
  createDirIfNotExists(program.outDir);
}


program.option('-u --urls <urls>', 'Comma separated url list for scan', list).
  option('-p, --preset <preset>',
    'Table preset (minimal, seo, seo-minimal, headers, parse, lighthouse, lighthouse-all)',
    getConfigVal('preset', 'seo')).
  option('-t, --timeout <timeout>',
    'Timeout for page request, in ms',
    getConfigVal('timeout', 10000)).
  option('-e, --exclude <fields>',
    'Comma separated fields to exclude from results', list).
  option('-d, --max-depth <depth>', 'Max scan depth',
    getConfigVal('maxDepth', 10)).
  option('-c, --concurrency <threads>',
    `Threads number (default: ${Math.min(10, os.cpus().length)})`).
  option('--lighthouse', 'Appends base Lighthouse fields to preset').
  option('--delay <ms>', 'Delay between requests', parseInt, 0).
  option('-f, --fields <json>',
    'Field in format --field \'title=$("title").text()\'', fieldsCustomCollect,
    []).
  option('--default-filter <defaultFilter>', 'Default filter when JSON viewed, example: depth>1').
  option('--no-skip-static', `Scan static files`).
  option('--no-limit-domain', `Scan not only current domain`).
  option('--docs-extensions <ext>',
    `Comma-separated extensions that will be add to table (default: ${defaultDocs.join(
      ',')})`, list).
  option('--follow-xml-sitemap', `Follow sitemap.xml`,
    getConfigVal('followXmlSitemap', false)).
  option('--ignore-robots-txt', `Ignore disallowed in robots.txt`,
    getConfigVal('ignoreRobotsTxt', false)).
  option('--url-list', `assume that --url contains url list, will set -d 1 --no-limit-domain --ignore-robots-txt`,
    getConfigVal('ignoreRobotsTxt', false)).
  option('--remove-selectors <selectors>', `CSS selectors for remove before screenshot, comma separated`,
    '.matter-after,#matter-1,[data-slug]').
  option('-m, --max-requests <num>', `Limit max pages scan`,
    parseInt, getConfigVal('maxRequests', 0)).
  option('--influxdb-max-send <num>', `Limit send to InfluxDB`,
    getConfigVal('influxdb.maxSendCount', 5)).
  option('--no-headless', `Show browser GUI while scan`,
    !getConfigVal('headless', true)).
  option('--remove-csv', `Delete csv after json generate`,
    getConfigVal('removeCsv', true)).
  option('--remove-json', `Delete json after serve`,
    getConfigVal('removeJson', true)).
  option('--no-remove-csv', `No delete csv after generate`).
  option('--no-remove-json', `No delete json after serve`).
  option('--out-dir <dir>', `Output directory`,
    getConfigVal('outDir', '~/site-audit-seo/')).
  option('--out-name <name>', `Output file name, default: domain`).
  option('--csv <path>', `Skip scan, only convert existing csv to json`).
  option('--json', `Save as JSON`, getConfigVal('json', true)).
  option('--no-json', `No save as JSON`, !getConfigVal('json', true)).
  option('--upload', `Upload JSON to public web`,
    getConfigVal('upload', false)).
  option('--no-color', `No console colors`).
  option('--partial-report <partialReport>', ``).
  option('--lang <lang>', `Language (en, ru, default: system language)`,
    getConfigVal('lang', undefined)).
  option('--no-console-validate', `Don't output validate messages in console`).
  option('--disable-plugins <plugins>', `Comma-separated plugin list`, list, []).
  option('--screenshot', `Save page screenshot`, getConfigVal('screenshot', false)).
  name('site-audit-seo').
  version(packageJson.version).
  usage('-u https://example.com')

program.getOptions = () => {
  const opts = {
    fieldsPreset: program.preset,              // варианты: default, seo, headers, minimal
    fieldsExclude: program.exclude,             // исключить поля
    maxDepth: program.maxDepth,                 // chrome-crawler, глубина сканирования
    maxConcurrency: parseInt(program.concurrency), // chrome-crawler, параллельно открываемые вкладки
    lighthouse: program.lighthouse,             // сканировать через lighthouse
    delay: parseInt(program.delay),             // задержка между запросами
    skipStatic: program.skipStatic,             // не пропускать подгрузку браузером статики (картинки, css, js)
    followSitemapXml: program.followXmlSitemap, // chrome-crawler, чтобы найти больше страниц
    limitDomain: program.limitDomain,           // не пропускать подгрузку браузером статики (картинки, css, js)
    urlList: program.urlList,                   // метка, что передаётся страница со списком url
    maxRequest: program.maxRequests,            // chrome-crawler, для тестов
    headless: program.headless,                 // chrome-crawler, на десктопе открывает браузер визуально
    docsExtensions: program.docsExtensions,     // расширения, которые будут добавлены в таблицу
    outDir: program.outDir,                     // папка, куда сохраняются csv
    outName: program.outName,                   // имя файла
    color: program.color,                       // раскрашивать консоль
    lang: program.lang,                         // язык
    fields: program.fields,                     // дополнительные поля, --fields 'title=$("title").text()'
    defaultFilter: program.defaultFilter,       //
    removeCsv: program.removeCsv,               // удалять csv после генерации
    removeJson: program.removeJson,             // удалять json после поднятия сервера
    json: program.json,                         // сохранять json файл
    upload: program.upload,                     // выгружать json на сервер
    consoleValidate: program.consoleValidate,   // выводить данные валидации в консоль
    obeyRobotsTxt: !program.ignoreRobotsTxt,    // chrome-crawler, не учитывать блокировки в robots.txt
    influxdb: program.influxdb,                 // конфиг influxdb
    screenshot: program.screenshot,             // делать ли скриншот
    removeSelectors: program.removeSelectors,   // удалить селекторы перед скриншотом
    urls: program.urls,                         // адреса для одиночного сканирования
    timeout: program.timeout,                   // таймаут запроса одной страницы
    disablePlugins: program.disablePlugins,
    partialReport: program.partialReport,
  };
  return opts;
}

program.outBrief = (options) => {
  let brief = [
    {
      name: 'Preset',
      value: program.preset,
      comment: '--preset [minimal, seo, seo-minimal, headers, parse, lighthouse, lighthouse-all]',
    },
    {
      name: 'Threads',
      value: program.concurrency,
      comment: '-c threads' +
        (program.concurrency > 1 && program.lighthouse ?
          `, ${color.yellow}recommended to set -c 1 when using lighthouse${color.reset}`
          : '') +
        (config.maxConcurrency ? `, max: ${config.maxConcurrency}` : ''),
    },
    {
      name: 'Lighthouse',
      value: (program.lighthouse ? 'yes' : 'no'),
      comment: (program.lighthouse ? '' : '--lighthouse')
    },
    {
      name: 'Delay',
      value: program.delay,
      comment: '--delay ms',
    },
    {
      name: 'Timeout',
      value: program.timeout,
      comment: '--timeout ms',
    },
    {
      name: 'Ignore robots.txt',
      value: (program.ignoreRobotsTxt ? 'yes' : 'no'),
      comment: (!program.ignoreRobotsTxt ? '--ignore-robots-txt' : ''),
    },
    {
      name: 'Follow sitemap.xml',
      value: (program.followXmlSitemap ? 'yes' : 'no'),
      comment: (!program.followXmlSitemap ? '--follow-xml-sitemap' : ''),
    },
    {
      name: 'Max depth',
      value: program.maxDepth,
      comment: '-d 8',
    },
    {
      name: 'Max requests',
      value: program.maxRequests ? program.maxRequests : 'unlimited',
      comment: '-m 123',
    },
    {
      name: 'Language',
      value: program.lang,
      comment: '--lang [en, fr, de, ru]',
    },
    /*{
      name: 'Docs extensions',
      value: program.docsExtensions.join(','),
      comment: '--docs-extensions zip,rar',
    },*/
  ];

  if (options.screenshot) {
    brief = [...brief, ...[
      {
        name: 'Screenshot',
        value: (program.screenshot ? 'yes' : 'no'),
        comment: (program.screenshot ? '' : '--screenshot')
      },
      {
        name: 'Remove selectors',
        value: (program.removeSelectors ? program.removeSelectors : 'no'),
        comment: (program.removeSelectors ? '' : '--remove-selectors .banner')
      },
    ]]
  }

  const fieldsArg = Object.entries(fieldsCustom).map(([key, value]) => `${key} (${value})`).join(', ');
  if (fieldsArg) {
    brief = [...brief, ...[
      {
        name: 'Fields',
        // join fieldsCustom object to string "key (value), key (value)"
        value: fieldsArg,
        //value: fieldsCustom.map((f, name) => `${name} (${f})`),
        comment: '',
      },
    ]]
  }

  if (options.partialReport) {
    brief = [...brief, ...[
      {
        name: 'Previous report',
        value: options.partialReport,
        comment: '--partial-report data/report/...json',
      },
    ]];
  }

  if (options.influxdb) {
    brief = [...brief, ...[
      {
        name: 'InfluxDB max send',
        value: program.influxdbMaxSend,
        comment: '--influxdb-max-send 10',
      },
    ]];
  }

  // only for command
  if (!options.webService) {
    brief = [...brief, ...[
      {
        name: 'Headless',
        value: (program.headless ? 'yes' : 'no'),
        comment: (program.headless ? '--no-headless' : ''),
      },
      {
        name: 'Save as JSON',
        value: (program.json ? 'yes' : 'no'),
        comment: (program.json ? '--no-json' : ''),
      },
      {
        name: 'Upload JSON',
        value: (program.upload ? 'yes' : 'no'),
        comment: (!program.upload ? '--upload' : ''),
      }
    ]];
  }

  console.log('');
  for (let line of brief) {
    const nameCol = line.name.padEnd(20, ' ');
    const valueCol = `${line.value}`.padEnd(10, ' ');
    const comment = line.comment ? ` ${line.comment}` : '';
    console.log(color.white + nameCol + valueCol + color.reset + comment);
    if (options.socket) options.socket.emit('status' + (options.socket.uid || ''), '<pre>' + nameCol + valueCol + comment + '</pre>');
  }
  console.log('');
  if (options.socket) options.socket.emit('status' + (options.socket.uid || ''), '&nbsp;');
}

export default program;
