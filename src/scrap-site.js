// see API - https://github.com/yujiosaka/headless-chrome-crawler/blob/master/docs/API.md#event-requeststarted
const fs = require('fs');
const path = require('path');
const {saveAsXlsx, saveAsJson, uploadJson, publishGoogleDrive, startViewer, sendToInfluxDB} = require(
  './actions');
const axios = require('axios');
const HCCrawler = require('@popstas/headless-chrome-crawler');
const CSVExporter = require('@popstas/headless-chrome-crawler/exporter/csv');
const url = require('url');
const {validateResults, getValidationSum} = require('./validate');
const {exec} = require('child_process');
const lighthouse = require('lighthouse');
const chromeLauncher = require('chrome-launcher');
const sanitize = require("sanitize-filename");
// поля описаны в API по ссылке выше
const fieldsPresets = require('./presets/scraperFields');
const color = require('./color');

const DEBUG = true; // выключить, если не нужны console.log на каждый запрос (не будет видно прогресс)


// запреты браузеру на подгрузку статики, ускоряет
let SKIP_IMAGES = true;
let SKIP_CSS = true;
let SKIP_JS = true;

// кол-во попыток выполнить actions
const finishTries = 5;

function socketSend(socket, event, msg) {
  if (socket) {
    // console.log(event + socket.uid + ': ', msg);
    socket.emit(event + (socket.uid || ''), msg);
  }
}

module.exports = async (baseUrl, options = {}) => {
  const domain = url.parse(baseUrl).hostname;
  const protocol = url.parse(baseUrl).protocol;

  const log = (msg) => {
    if (DEBUG) console.log(msg);
    socketSend(options.socket, 'status', msg);
  };

  let urls = [];
  if (options.urlList) {
    const regex = /(?:(?:https?|ftp|file):\/\/|www\.|ftp\.)(?:\([-A-Z0-9+&#\/%=~_|$?!:,.]*\)|[-A-Z0-9+&#\/%=~_|$?!:,.])*(?:\([-A-Z0-9+&#\/%=~_|$?!:,.]*\)|[A-Z0-9+&#\/%=~_|$])/ig

    let content;
    if (false || fs.existsSync(baseUrl)) { // TODO: url list from file
      content = fs.readFileSync(options.file, 'utf8');
    } else {
      res = await axios.get(baseUrl);
      content = res.data;
    }

    while (pageUrl = regex.exec(content)){
      if (pageUrl[0].match(/\.(png|jpg|js|css)$/)) continue;
      urls.push(pageUrl[0]);
    }

    const onlyUnique = (value, index, self) => self.indexOf(value) === index;
    urls = urls.filter(onlyUnique);

    // console.log('urls: ', urls);
  }

  const baseName = sanitize(options.outName || domain);
  const csvPath = path.normalize(`${options.outDir}/${baseName}.csv`);
  const xlsxPath = path.normalize(`${options.outDir}/${baseName}.xlsx`);
  const jsonPath = path.normalize(`${options.outDir}/${baseName}.json`);
  let webPath;

  if (!options.color) color.white = color.red = color.reset = color.yellow = '';

  if (!options.fieldsPreset || !fieldsPresets[options.fieldsPreset]) {
    options.fieldsPreset = 'default';
  }

  let fields = fieldsPresets[options.fieldsPreset];

  // exclude fields
  if (options.fieldsExclude && options.fieldsExclude.length > 0) {
    fields = fields.filter(f => {
      const fName = f.replace(/.*\./g, '');
      return !options.fieldsExclude.includes(fName);
    });
  }

  // custom fields
  if (Object.keys(options.fields).length > 0) {
    // console.log('options.fields: ', options.fields);
    const newFields = Object.keys(options.fields).map(f => 'result.' + f);
    fields = [...fields, ...newFields];
  }

  // lighthouse fields
  if (options.lighthouse) {
    for (let fName of fieldsPresets['lighthouse-all']) {
      if (fields.indexOf(fName) === -1) {
        fields.push(fName);
      }
    }
  }

  // skip static
  if (options.skipStatic !== undefined) {
    SKIP_IMAGES = SKIP_CSS = SKIP_JS = options.skipStatic;
  }

  // open second chrome for lighthouse
  let lighthouseChrome;
  if (options.lighthouse) {
    const chromeFlags = ['--no-sandbox'];
    if (options.headless) chromeFlags.push('--headless');
    lighthouseChrome = await chromeLauncher.launch({chromeFlags});
  }

  const exporter = new CSVExporter({
    file: csvPath,
    fields: fields,
    separator: ';',
  });

  let crawler;
  const defaultOptions = {
    allowedDomains: options.limitDomain ? [domain] : undefined,
    skipRequestedRedirect: true, // all redirects marks as visited
    depthPriority: false, // without it find not all pages
    args: ['--no-sandbox', '--disable-dev-shm-usage'], // puppeteer freezes without it
    exporter,

    // url ignore rules
    preRequest: options => {
      // console.log(options.url);
      if (options.url.match(/\.(jpg|jpeg|png|gif)/i)) return false; // картинки
      if (options.url.match(/\?width=\d+&height=\d+/)) return false; // визитки, сотрудники
      if (options.url.includes('?vi=y')) return false; // версия для слабовидящих
      if (options.url.includes('gallery/?page=detail')) return false; // Битрикс Галерея 2.0
      if (options.url.includes('/?lightbox=')) return false; // lightbox
      if (options.url.includes('rk.php')) return false; // bitrix rk
      if (options.url.includes('/?catalog_view=')) return false; // bitrix display
      if (options.url.includes('/?SORT=')) return false; // bitrix sort
      if (options.url.includes('/filter/clear/apply/')) return false; // bitrix filter
      // if (options.url.match(/\?(category|age|usage|madein|season|brand)=/)) return false; // bitrix filter

      // http scan while first page was https
      if (url.parse(options.url).protocol != protocol) return false;

      return true;
    },

    // сюда можно дописывать сборщики данных со страницы
    // поля надо добавить в fields выше
    evaluatePage: async () => {
      try {
        const customFields = await window.__customFields();
        // console.log('window.__customFields(): ', JSON.stringify(customFields));

        let domainParts = location.host.split('.');
        const domain2level = domainParts.slice(domainParts.length - 2).
          join('.');
        const canonical = $('link[rel="canonical"]').attr('href');
        const relUrl = window.location.href.replace(`${window.location.protocol}//${window.location.host}`, '');
        const isCanonical = canonical ?
          (canonical == decodeURI(window.location.href) ||
          canonical == decodeURI(relUrl) ? 1 : 0) : '';
        const result = {
          request_time:
            window.performance.timing.responseEnd -
            window.performance.timing.requestStart,
          title: $('title').text(),
          h1: $('h1').text().trim(),
          h1_count: $('h1').length,
          h2_count: $('h2').length,
          h3_count: $('h3').length,
          h4_count: $('h4').length,
          canonical_count: $('link[rel="canonical"]').length,
          google_amp: $('link[rel="amphtml"]').length,
          dom_size: document.getElementsByTagName('*').length,
          head_size: document.head.innerHTML.length,
          body_size: document.body.innerHTML.length,
          html_size: document.head.innerHTML.length +
            document.body.innerHTML.length,
          text_ratio_percent: Math.round(
            document.body.innerText.length / document.body.innerHTML.length *
            100),
          images: $('img').length,
          images_without_alt: $('img:not([alt]').length,
          images_alt_empty: $('img[alt=""]').length,
          images_outer: $(
            'img[src^="http"]:not([src^="/"]):not([src*="' + domain2level +
            '"])').length,
          links: $('a[href]:not([href^="javascript"]):not([href^="#"])').length,
          links_inner: $(
            'a[href^="/"], a[href*="' + domain2level + '"]').length,
          links_outer: $(
            'a[href^="http"]:not([href^="javascript"]):not([href^="#"]):not([href^="/"]):not([href*="' +
            domain2level + '"])').length,
          // links_absolute: $('').length,
          description:
            ($('meta[name="description"]').attr('content') &&
              $('meta[name="description"]').
                attr('content').
                split('\n').
                join(' ')) ||
            '',
          keywords: $('meta[name="keywords"]').attr('content'),
          canonical: canonical,
          is_canonical: isCanonical,
          og_title: $('meta[property="og:title"]').attr('content'),
          og_image: $('meta[property="og:image"]').attr('content'),
          schema_types: $.unique($('[itemtype]').
            map((i, item) => $(item).
              attr('itemType').
              replace(/https?:\/\/schema\.org\//, ''))).toArray().join(', '),
        };

        for (let name in customFields) {
          result[name] = eval(customFields[name].replace(/`/g, '\''));
          // if(name == 'section') result[name] = $('.views-field.views-field-field-section a').text();
        }

        return result;
      } catch (e) {
        return {
          error: JSON.stringify(e),
        };
      }
    },

    onSuccess: result => {
      if (!result.result) return;

      if (result.result.error) {
        const msg = `${color.red}Error collect page data: result.result.error${color.reset}`;
        console.error(msg);
      }
      // console.log(`html_size: ${result.result.html_size}`);
    },

    customCrawl: async (page, crawl, crawler) => {
      // You can access the page object before requests
      await page.setRequestInterception(true);
      await page.setBypassCSP(true);

      //page.on('console', msg => console.log(msg.text()));
      await page.exposeFunction('__customFields', () => {
        return options.fields;
      });

      let mixedContentUrl = '';

      // это событие срабатывает, когда chrome подгружает статику на странице (и саму страницу)
      page.on('request', request => {
        //console.log('request.url(): ', request.url());

        // check for mixed content, thanks to https://github.com/busterc/mixed-content-crawler/
        if (protocol == 'https:' &&
          ['image', 'stylesheet', 'script'].includes(request.resourceType()) &&
          request.url().match(/^http:/)) {
          request.notHTTPS = true;
          mixedContentUrl = request.url();
          return request.abort();
        }

        const isDoc = options.docsExtensions.some(
          ext => request.url().includes(`.${ext}`));
        if (isDoc) {
          // досюда как-то доходит
          request.abort();
        } else if (SKIP_IMAGES && request.resourceType() == 'image') {
          request.abort();
        } else if (SKIP_CSS && request.resourceType() == 'stylesheet') {
          request.abort();
        } else if (SKIP_JS && request.resourceType() == 'script') {
          request.abort();
        } else {
          request.continue();
        }
      });

      page.on('requestfailed', request => {
        if (request.notHTTPS) {
          console.error(
            `${color.red}mixed content: ${request.url()}${color.reset}`);
        } else {
          const isStatic = ['image', 'script', 'stylesheet'].includes(request.resourceType());
          if (!isStatic) console.log('Request failed: ', request.url() + ' ' + request.failure().errorText);
        }
      });

      /*page.on('error', function(err) {
        console.error(`${color.red}Page error:${color.reset} ` + err.toString());
      });*/

      /*page.on('close', function() {
        console.error(`${color.red}Page closed${color.reset} `);
      });*/

      /*page.on('pageerror', function(err) {
        console.error(`${color.red}pegeerror:${color.reset} ` + err.toString());
      });*/

      // console.log('co '+ crawler._options.url);

      // костыль, который возвращает фейково обойдённый документ, если он признан документом
      // нужно, чтобы доки не сканировались (выдают ошибку), но при этом добавлялись в csv
      // т.к. в этом контексте нет текущего урла, он задаётся в глобал через событие requeststarted
      const isDoc = crawler._options.url && options.docsExtensions.some(
        ext => crawler._options.url.includes(`.${ext}`));
      if (isDoc) {
        return {
          options: {},
          depth: 0,
          previousUrl: '',
          response: {
            url: crawler._options.url,
          },
          redirectChain: [],
          result: {},
          screenshot: null,
          cookies: [],
          links: [],
        };
      }

      // The result contains options, links, cookies and etc.
      const result = await crawl();

      if (options.lighthouse) {
        const opts = {
          // extends: 'lighthouse:default',
          /*onlyAudits: [
            'first-meaningful-paint',
            'speed-index',
            'first-cpu-idle',
            'interactive',
          ],*/
          // onlyCategories : [ 'performance'/*, 'pwa', 'accessibility', 'best-practices', 'seo'*/ ],
          port: lighthouseChrome.port,
          locale: options.lang,
        };
        const res = await lighthouse(crawler._options.url, opts);
        const data = JSON.parse(res.report);

        const audits = [
          'first-contentful-paint',
          'speed-index',
          'largest-contentful-paint',
          'interactive',
          'total-blocking-time',
          'cumulative-layout-shift',
        ];
        const categories = [
          'performance',
          'accessibility',
          'best-practices',
          'seo',
          'pwa'];
        const lighthouseData = {
          scores: {},
        };

        const fieldConfigs = []; // для генерации конфига полей

        for (let auditName of audits) {
          if (!data.audits[auditName]) continue;
          lighthouseData[auditName] = parseInt(
            data.audits[auditName].numericValue);
        }

        for (let categoryId of categories) {
          if (!data.categories[categoryId]) continue;

          // lighthouse.scores
          lighthouseData.scores[categoryId] = parseInt(
            data.categories[categoryId].score * 100);

          // all audits
          for (let auditRef of data.categories[categoryId].auditRefs) {
            let value;
            const auditName = auditRef.id;
            const audit = data.audits[auditName];

            if (audit.numericValue) value = parseInt(audit.numericValue);
            else value = audit.score;

            lighthouseData[auditName] = value;

            // add to sheet fields
            if (options.fieldsPreset === 'lighthouse-all') {
              const fieldId = 'lighthouse.' + auditName;
              if (fields.indexOf(fieldId) === -1) {
                fields.push(fieldId);
              }
            }

            // generate field config
            const fieldConfig = {
              name: 'lighthouse_' + audit.id,
              comment: audit.title,
              description: audit.description,
              groups: ['# Lighthouse: ' + data.categories[categoryId].title],
              type: 'integer',
            };
            if (auditRef.group) {
              const groupTitle = data.categories[categoryId].title + ': ' +
                data.categoryGroups[auditRef.group].title;
              fieldConfig.groups.push(groupTitle);
              // fieldConfig.groups = [groupTitle];
            }
            fieldConfigs.push(fieldConfig);
          }
        }

        result.lighthouse = lighthouseData;
        // console.log(JSON.stringify(fieldConfigs)); // copy to fields.js
        // console.log(lighthouseData);
      }

      result.result.mixed_content_url = mixedContentUrl;
      if (result.response.url) result.response.url = decodeURI(
        result.response.url);

      // console validate output
      // was in onSuccess(), but causes exception on docs
      const msgs = [];
      const validate = validateResults(result, fields); // TODO: fields declared implicitly
      for (let name in validate) {
        const res = validate[name];
        const msgColor = {warning: color.yellow, error: color.red}[res.type];
        msgs.push(`${name}: ${msgColor}${res.msg}${color.reset}`);
      }
      if (msgs.length > 0) console.log(msgs.join(', '));

      // You can access the page object after requests
      result.content = await page.content();
      // You need to extend and return the crawled result
      return result;
    },
  };

  const crawlerOptions = {...defaultOptions, ...options};

  // start
  const start = Date.now();

  console.log(`${color.yellow}Scrapping ${baseUrl}...${color.reset}`);
  let requestedCount = 0;

  try {
    crawler = await HCCrawler.launch(crawlerOptions);
  } catch (e) {
    console.log(e);
  }

  crawler.on('requeststarted', async options => {
    const queueCount = await crawler.queueSize();
    requestedCount = crawler.requestedCount() + 1;
    log(`${requestedCount} ${decodeURI(options.url)} (${queueCount})`);
  });
  crawler.on('requestfailed', error => {
    console.error(
      `${color.red}Failed: ${decodeURI(error.options.url)}${color.reset}`);
  });
  crawler.on('requestdisallowed', options => {
    console.error(`${color.yellow}Disallowed in robots.txt: ${decodeURI(
      options.url)}${color.reset}`);
  });
  crawler.on('maxdepthreached', opts => {
    if (options.maxDepth > 1) console.log(`${color.yellow}Max depth reached${color.reset}`);
  });
  crawler.on('maxrequestreached', options => {
    console.log(
      `\n\n${color.yellow}Max requests reached\nPlease, ignore this error:${color.reset}`);
  });

  if (options.urlList) {
    for (let url of urls) {
      await crawler.queue(url);
    }
  } else {
    await crawler.queue(baseUrl);
  }

  await crawler.onIdle();
  await crawler.close();

  // after scan
  const t = Math.round((Date.now() - start) / 1000);
  const perPage = Math.round((t / requestedCount) * 100) / 100;

  // close lighthouse's chrome
  await chromeLauncher.killAll();

  const outValidationSummary = () => {
    const sum = getValidationSum();
    if (Object.entries(sum).length === 0) return;
    console.log(`\n\n${color.white}Validation summary:${color.reset}`);
    for (let colName in sum) {
      console.log(`\n${color.white}${colName}:${color.reset}`);
      for (let res of sum[colName]) {
        const msgColor = {warning: color.yellow, error: color.red}[res.type];
        console.log(`${msgColor}${res.msg}${color.reset}\t${res.url}`);
      }
    }
  };

  const finishScan = async () => {
    console.log('');
    if (options.xlsx) {
      saveAsXlsx(csvPath, xlsxPath);
      if (options.gdrive) await publishGoogleDrive(xlsxPath);
      if (options.openFile) exec(`"${xlsxPath}"`);
    }

    if (options.json) {
      await saveAsJson(csvPath, jsonPath, options.lang, options.preset, options.defaultFilter);
      if (!options.removeJson) console.log('Saved to ' + jsonPath);
      if (options.upload) webPath = await uploadJson(jsonPath, options);
      // if (options.gdrive) webPath = await publishGoogleDrive(jsonPath);

      await startViewer(jsonPath, webPath);
      if (options.removeJson) fs.unlinkSync(jsonPath);
    }

    if (options.removeCsv) fs.unlinkSync(csvPath);

    const mins = Number(t / 60).toFixed(1);
    console.log(`Finish: ${mins} mins (${perPage} sec per page)`);
  };

  outValidationSummary();

  const tryFinish = async (tries) => {
    try {
      await finishScan();
    } catch (e) {
      if (e.code == 'EBUSY') {
        let msg = `${color.red}${xlsxPath} is busy`;
        if (tries > 0) msg += ', please close file in 10 seconds!';
        console.error(msg);

        if (tries > 0) {
          setTimeout(async () => {
            await tryFinish(tries - 1);
          }, 10000);
        }
      } else {
        console.error(e);
      }
    }
  };

  if (options.webService) {
    try {
      await saveAsJson(csvPath, jsonPath, options.lang, options.preset, options.defaultFilter);

      if (options.influxdb) {
        log('send to InfluxDB...');
        const points = await sendToInfluxDB(jsonPath, options);
        log(`sent ${points.length} points`);
      }

      // copy to local reports
      let localDir = 'data/reports/';
      if (options.socket.uid) {
        const userDir = sanitize(options.socket.uid.slice(0, 5));
        localDir += userDir + '/';
        if (!fs.existsSync(localDir)) fs.mkdirSync(localDir);
      }

      // remove microseconds if available
      const jsonNameLong = getJsonName(jsonPath);
      const jsonNameShort = getJsonName(jsonPath, true);
      const jsonName = fs.existsSync(localDir + jsonNameShort) ? jsonNameLong : jsonNameShort;
      const localPath = localDir + jsonName;
      fs.copyFileSync(jsonPath, localPath);

      socketSend(options.socket, 'result', {name: jsonName});

      // TODO: error upload 8MB+
      if (options.upload) {
        webPath = await uploadJson(jsonPath, options);
        socketSend(options.socket, 'result', {json: webPath});
      }
    }
    catch (e) {
      log('error after scan: ' + e.message);
    }
  }
  else {
    await tryFinish(finishTries);
  }
};

function getJsonName(jsonPath, short = false) {
  const offset = new Date().getTimezoneOffset() * 60000;
  const dateLocal = new Date(Date.now() - offset)
  let date = dateLocal.toISOString().
    replace(/:/g, '-').
    replace('T', '__').
    replace('Z', '');
  if (short) date = date.replace(/\.\d+/, '');
  // const dateStr = date.slice(0,10);
  const name = path.basename(jsonPath).replace(/[^0-9a-zа-я_.-]/ig, '');
  const uploadName = date + '__' + name;
  return uploadName;
}
