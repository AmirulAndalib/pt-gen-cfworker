const cheerio = require("cheerio"); // HTML页面解析
const HTML2BBCode = require("html2bbcode").HTML2BBCode;

/**
 * Cloudflare Worker entrypoint
 */
addEventListener("fetch", event => {
  event.respondWith(handle(event));
});

// 常量定义
const AUTHOR = "Rhilip";
const VERSION = "0.6.1";

const support_list = {
  // 注意value值中正则的分组只能有一个，而且必须是sid信息，其他分组必须设置不捕获属性
  "douban": /(?:https?:\/\/)?(?:(?:movie|www)\.)?douban\.com\/(?:subject|movie)\/(\d+)\/?/,
  "imdb": /(?:https?:\/\/)?(?:www\.)?imdb\.com\/title\/(tt\d+)\/?/,
  "bangumi": /(?:https?:\/\/)?(?:bgm\.tv|bangumi\.tv|chii\.in)\/subject\/(\d+)\/?/,
  "steam": /(?:https?:\/\/)?(?:store\.)?steam(?:powered|community)\.com\/app\/(\d+)\/?/,
  "indienova": /(?:https?:\/\/)?indienova\.com\/game\/(\S+)/,
  "epic": /(?:https?:\/\/)?www\.epicgames\.com\/store\/[a-zA-Z-]+\/product\/(\S+)\/\S?/
};

const support_site_list = Object.keys(support_list);

/** 公有的JSON字段，其他字段为不同生成模块的信息
 *  考虑到历史兼容的问题，应该把所有字段都放在顶层字典
 *  （虽然说最好的实践是放在 root.data 里面
 */
const default_body = {
  "success": false, // 请求是否成功，客户端应该首先检查该字段
  "error": null, // 如果请求失败，此处为失败原因
  "format": "", // 使用BBCode格式整理的简介
  "copyright": `Powered by @${AUTHOR}`, // 版权信息
  "version": VERSION, // 版本
  "generate_at": 0 // 生成时间（毫秒级时间戳），可以通过这个值与当前时间戳比较判断缓存是否应该过期
};

const NONE_EXIST_ERROR = "The corresponding resource does not exist.";

/**
 * Fetch and log a request
 * @param {Event} event
 */
async function handle(event) {
  const request = event.request; // 获取请求
  
  // 处理OPTIONS
  if (request.method === "OPTIONS") {
    return handleOptions(request);
  }

  // 检查缓存，命中则直接返回
  const cache = caches.default; // 定义缓存
  let response = await cache.match(request);

  if (!response) { // 未命中缓存
    // 使用URI() 解析request.url
    let uri = new URL(request.url);

    try {
      // 不存在任何请求字段，且在根目录，返回默认页面（HTML）
      if (uri.pathname === '/' && uri.search === '') {
        response = await makeIndexResponse();
      }
      // 其他的请求均应视为ajax请求，返回JSON
      else if (uri.searchParams.get('search')) {
        // 搜索类（通过PT-Gen代理）
        let keywords = uri.searchParams.get('search');
        let source = uri.searchParams.get('source') || 'douban';

        if (support_site_list.includes(source)) {
          if (source === 'douban') {
            response = await search_douban(keywords)
          } else if (source === 'bangumi') {
            response = await search_bangumi(keywords)
          } else if (source === 'imdb') {
            response = await search_imdb(keywords)
          } else {
            // 没有对应方法搜索的资源站点
            response = makeJsonResponse({
              error: "Miss search function for `source`: " + source + "."
            });
          }
        } else {
          response = makeJsonResponse({
            error: "Unknown value of key `source`."
          });
        }
      } else {
        // 内容生成类
        let site, sid;

        // 请求字段 `&url=` 存在
        if (uri.searchParams.get("url")) {
          let url_ = uri.searchParams.get("url");
          for (let site_ in support_list) {
            let pattern = support_list[site_];
            if (url_.match(pattern)) {
              site = site_;
              sid = url_.match(pattern)[1];
              break;
            }
          }
        } else {
          site = uri.searchParams.get("site");
          sid = uri.searchParams.get("sid");
        }

        // 如果site和sid不存在的话，提前返回
        if (site == null || sid == null) {
          response = makeJsonResponse({
            error: "Miss key of `site` or `sid` , or input unsupported resource `url`."
          });
        } else {
          if (support_site_list.includes(site)) {
            // 进入对应资源站点处理流程
            if (site === "douban") {
              response = await gen_douban(sid);
            } else if (site === "imdb") {
              response = await gen_imdb(sid);
            } else if (site === "bangumi") {
              response = await gen_bangumi(sid);
            } else if (site === "steam") {
              response = await gen_steam(sid);
            } else if (site === "indienova") {
              response = await gen_indienova(sid);
            } else if (site === "epic") {
              response = await gen_epic(sid);
            } else {
              // 没有对应方法的资源站点，（真的会有这种情况吗？
              response = makeJsonResponse({
                error: "Miss generate function for `site`: " + site + "."
              });
            }
          } else {
            response = makeJsonResponse({
              error: "Unknown value of key `site`."
            });
          }
        }
      }

      // 添加缓存，此处如果response如果为undefined的话会抛出错误
      event.waitUntil(cache.put(request, response.clone()));
    } catch (e) {
      let err_return = {
        error: `Internal Error, Please contact @${AUTHOR}. Exception: ${e.message}`
      };
      
      if (uri.searchParams.get("debug") === '1') {
        err_return['debug'] = debug_get_err(e, request);
      }

      response = makeJsonResponse(err_return);
      // 当发生Internal Error的时候不应该进行cache
    }
  }

  return response;
}

//-    辅助方法      -//
function handleOptions(request) {
  if (request.headers.get("Origin") !== null &&
    request.headers.get("Access-Control-Request-Method") !== null &&
    request.headers.get("Access-Control-Request-Headers") !== null) {
    // Handle CORS pre-flight request.
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
        "Access-Control-Allow-Headers": "Access-Control-Allow-Headers, Origin,Accept, X-Requested-With, Content-Type, Access-Control-Request-Method, Access-Control-Request-Headers"
      }
    })
  } else {
    // Handle standard OPTIONS request.
    return new Response(null, {
      headers: {
        "Allow": "GET, HEAD, OPTIONS",
      }
    })
  }
}

// 返回Json请求
function makeJsonResponse(body_update) {
  let body = Object.assign({},
    default_body,
    body_update, {
      generate_at: (new Date()).valueOf()
    }
  );
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*" // CORS
    }
  });
}

// 解析HTML页面
function page_parser(responseText) {
  return cheerio.load(responseText, {
    decodeEntities: false
  });
}

// 解析JSONP返回
function jsonp_parser(responseText) {
  try {
    responseText = responseText.replace(/\n/ig,'').match(/[^(]+\((.+)\)/)[1];
    return JSON.parse(responseText);
  } catch (e) {
    return {}
  }
}

// Html2bbcode
function html2bbcode(html) {
  let converter = new HTML2BBCode();
  let bbcode = converter.feed(html);
  return bbcode.toString();
}

function getNumberFromString(raw) {
  return (raw.match(/[\d,]+/) || [0])[0].replace(/,/g, "");
}

function debug_get_err(err, request) {
  const errType = err.name || (err.contructor || {}).name;
  const frames = parse_err(err);
  const extraKeys = Object.keys(err).filter(key => !['name', 'message', 'stack'].includes(key));
  return {
    message: errType + ': ' + (err.message || '<no message>'),
    exception: {
      values: [
        {
          type: errType,
          value: err.message,
          stacktrace: frames.length ? { frames: frames.reverse() } : undefined,
        },
      ],
    },
    extra: extraKeys.length
      ? {
          [errType]: extraKeys.reduce((obj, key) => ({ ...obj, [key]: err[key] }), {}),
        }
      : undefined,
    timestamp: Date.now() / 1000,
    request:
      request && request.url
        ? {
            method: request.method,
            url: request.url,
            query_string: request.query,
            headers: request.headers,
            data: request.body,
          }
        : undefined,
  }
}

function parse_err(err) {
  return (err.stack || '')
    .split('\n')
    .slice(1)
    .map(line => {
      if (line.match(/^\s*[-]{4,}$/)) {
        return { filename: line }
      }

      // From https://github.com/felixge/node-stack-trace/blob/1ec9ba43eece124526c273c917104b4226898932/lib/stack-trace.js#L42
      const lineMatch = line.match(/at (?:(.+)\s+\()?(?:(.+?):(\d+)(?::(\d+))?|([^)]+))\)?/);
      if (!lineMatch) {
        return
      }

      return {
        function: lineMatch[1] || undefined,
        filename: lineMatch[2] || undefined,
        lineno: +lineMatch[3] || undefined,
        colno: +lineMatch[4] || undefined,
        in_app: lineMatch[5] !== 'native' || undefined,
      }
    })
    .filter(Boolean)
}

// 各个资源站点的相应资源搜索整理方法
async function search_douban(query) {
  let douban_search = await fetch(`https://movie.douban.com/j/subject_suggest?q=${query}`);
  let douban_search_json = await douban_search.json();

  return makeJsonResponse({
    data: douban_search_json.map(d => {
      return {
        year: d.year,
        subtype: d.type,
        title: d.title,
        subtitle: d.sub_title,
        link: `https://movie.douban.com/subject/${d.id}/`
      }
    })
  })
}

async function search_imdb(query) {
  query = query.toLowerCase()  // 大写字母须转成小写
  let imdb_search = await fetch(`https://v2.sg.media-imdb.com/suggestion/${query.slice(0, 1)}/${query}.json`)
  let imdb_search_json = await imdb_search.json();
  return makeJsonResponse({
    data: (imdb_search_json.d || []).filter(d => {
      return /^tt/.test(d.id)
    }).map(d => {
      return {
        year: d.y,
        subtype: d.q,
        title: d.l,
        link: `https://www.imdb.com/title/${d.id}`
      }
    })
  })
}

async function search_bangumi(query) {
  const tp_dict = {1: "漫画/小说", 2: "动画/二次元番", 3: "音乐", 4: "游戏", 6: "三次元番"};
  let bgm_search = await fetch(`http://api.bgm.tv/search/subject/${query}?responseGroup=large`)
  let bgm_search_json = await bgm_search.json();
  return makeJsonResponse({
    data: bgm_search_json.list.map(d => {
      return {
        year: d['air_date'].slice(0, 4),
        subtype: tp_dict[d['type']],
        title: d['name_cn'] !== '' ? d['name_cn'] : d['name'],
        subtitle: d['name'],
        link: d['url']
      }
    })
  })
}

// 各个资源站点的相应请求整理方法，统一使用async function
async function gen_douban(sid) {
  let data = {
    site: "douban",
    sid: sid
  };

  // 下面开始正常的豆瓣处理流程
  let douban_link = `https://movie.douban.com/subject/${sid}/`;  // 构造链接
  let db_page_resp = await fetch(douban_link); // 请求豆瓣对应项目主页面
  let douban_page_raw = await db_page_resp.text();

  // 对异常进行处理
  if (douban_page_raw.match(/你想访问的页面不存在/)) {
    return makeJsonResponse(Object.assign(data, {
      error: NONE_EXIST_ERROR
    }));
  } else if (douban_page_raw.match(/检测到有异常请求/)) { // 真的会有这种可能吗？
    return makeJsonResponse(Object.assign(data, {
      error: "GenHelp was temporary banned by Douban, Please wait...."
    }));
  } else {
    let awards_page_req = fetch(`${douban_link}awards`) // 马上请求豆瓣获奖界面

    // 解析主页面
    let $ = page_parser(douban_page_raw);

    let title = $("title").text().replace("(豆瓣)", "").trim();

    // 从ld+json中获取原来API返回的部分信息
    let ld_json = JSON.parse($('head > script[type="application/ld+json"]').html().replace(/\n/ig,''));

    // 元素获取方法
    let fetch_anchor = function (anchor) {
      return anchor[0].nextSibling.nodeValue.trim();
    };

    // 所有需要的元素
    let poster;
    let this_title, trans_title, aka;
    let year, region, genre, language, playdate;
    let imdb_link, imdb_id, imdb_average_rating, imdb_votes, imdb_rating;
    let douban_average_rating, douban_votes, douban_rating;
    let episodes, duration;
    let director, writer, cast;
    let tags, introduction, awards;

    // 提前imdb相关请求
    let imdb_link_anchor = $("div#info a[href*='://www.imdb.com/title/tt']");
    let has_imdb = imdb_link_anchor.length > 0;
    if (has_imdb) {
      data["imdb_link"] = imdb_link = imdb_link_anchor.attr("href").replace(/(\/)?$/, "/").replace("http://", "https://");
      data["imdb_id"] = imdb_id = imdb_link.match(/tt\d+/)[0];
      let imdb_api_resp = await fetch(`https://p.media-imdb.com/static-content/documents/v1/title/${imdb_id}/ratings%3Fjsonp=imdb.rating.run:imdb.api.title.ratings/data.json`);
      let imdb_api_raw = await imdb_api_resp.text();
      let imdb_json = jsonp_parser(imdb_api_raw);

      if (imdb_json["resource"]) {
        data["imdb_rating_average"] = imdb_average_rating = imdb_json["resource"]["rating"] || 0;
        data["imdb_votes"] = imdb_votes = imdb_json["resource"]["ratingCount"] || 0;
        data["imdb_rating"] = imdb_rating = `${imdb_average_rating}/10 from ${imdb_votes} users`;
      }
    }

    let chinese_title = data["chinese_title"] = title;
    let foreign_title = data["foreign_title"] = $("span[property=\"v:itemreviewed\"]").text().replace(data["chinese_title"], "").trim();

    let aka_anchor = $("#info span.pl:contains(\"又名\")");
    if (aka_anchor.length > 0) {
      aka = fetch_anchor(aka_anchor).split(" / ").sort(function (a, b) { //首字(母)排序
        return a.localeCompare(b);
      }).join("/");
      data["aka"] = aka.split("/");
    }

    if (foreign_title) {
      trans_title = chinese_title + (aka ? ("/" + aka) : "");
      this_title = foreign_title;
    } else {
      trans_title = aka ? aka : "";
      this_title = chinese_title;
    }

    data["trans_title"] = trans_title.split("/");
    data["this_title"] = this_title.split("/");

    let regions_anchor = $("#info span.pl:contains(\"制片国家/地区\")"); //产地
    let language_anchor = $("#info span.pl:contains(\"语言\")"); //语言
    let episodes_anchor = $("#info span.pl:contains(\"集数\")"); //集数
    let duration_anchor = $("#info span.pl:contains(\"单集片长\")"); //片长

    data["year"] = year = " " + $("#content > h1 > span.year").text().substr(1, 4);
    data["region"] = region = regions_anchor[0] ? fetch_anchor(regions_anchor).split(" / ") : "";

    data["genre"] = genre = $("#info span[property=\"v:genre\"]").map(function () { //类别
      return $(this).text().trim();
    }).toArray();

    data["language"] = language = language_anchor[0] ? fetch_anchor(language_anchor).split(" / ") : "";

    data["playdate"] = playdate = $("#info span[property=\"v:initialReleaseDate\"]").map(function () { //上映日期
      return $(this).text().trim();
    }).toArray().sort(function (a, b) { //按上映日期升序排列
      return new Date(a) - new Date(b);
    });

    data["episodes"] = episodes = episodes_anchor[0] ? fetch_anchor(episodes_anchor) : "";
    data["duration"] = duration = duration_anchor[0] ? fetch_anchor(duration_anchor) : $("#info span[property=\"v:runtime\"]").text().trim();

    // 简介 首先检查是不是有隐藏的，如果有，则直接使用隐藏span的内容作为简介，不然则用 span[property="v:summary"] 的内容
    let introduction_another = $('#link-report > span.all.hidden, #link-report > [property="v:summary"]')
    data["introduction"] = introduction = (
      introduction_another.length > 0 ? introduction_another.text() : '暂无相关剧情介绍'
    ).split('\n').map(a => a.trim()).filter(a => a.length > 0).join('\n');  // 处理简介缩进

    // 从ld_json中获取信息
    data["douban_rating_average"] = douban_average_rating = ld_json['aggregateRating'] ? ld_json['aggregateRating']['ratingValue'] : 0;
    data["douban_votes"] = douban_votes = ld_json['aggregateRating'] ? ld_json['aggregateRating']['ratingCount'] : 0;
    data["douban_rating"] = douban_rating = `${douban_average_rating}/10 from ${douban_votes} users`;

    data["poster"] = poster = ld_json['image']
      .replace(/s(_ratio_poster|pic)/g, "l$1")
      .replace("img3", "img1");

    data["director"] = director = ld_json['director'] ? ld_json['director'] : [];
    data["writer"] = writer = ld_json['author'] ? ld_json['author'] : [];
    data["cast"] = cast = ld_json['actor'] ? ld_json['actor'] : [];

    let tag_another = $('div.tags-body > a[href^="/tag"]');
    if (tag_another.length > 0) {
      data["tags"] = tags = tag_another.map(function () {return $(this).text()}).get();
    }

    let awards_page_resp = await awards_page_req;
    let awards_page_raw = await awards_page_resp.text();
    let awards_page = page_parser(awards_page_raw);
    data["awards"] = awards = awards_page("#content > div > div.article").html()
      .replace(/[ \n]/g, "")
      .replace(/<\/li><li>/g, "</li> <li>")
      .replace(/<\/a><span/g, "</a> <span")
      .replace(/<(div|ul)[^>]*>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/ +\n/g, "\n")
      .trim();

    // 生成format
    let descr = poster ? `[img]${poster}[/img]\n\n` : "";
    descr += trans_title ? `◎译　　名　${trans_title}\n` : "";
    descr += this_title ? `◎片　　名　${this_title}\n` : "";
    descr += year ? `◎年　　代　${year.trim()}\n` : "";
    descr += region ? `◎产　　地　${region}\n` : "";
    descr += genre ? `◎类　　别　${genre.join(" / ")}\n` : "";
    descr += language ? `◎语　　言　${language}\n` : "";
    descr += playdate ? `◎上映日期　${playdate.join(" / ")}\n` : "";
    descr += imdb_rating ? `◎IMDb评分  ${imdb_rating}\n` : "";
    descr += imdb_link ? `◎IMDb链接  ${imdb_link}\n` : "";
    descr += douban_rating ? `◎豆瓣评分　${douban_rating}\n` : "";
    descr += douban_link ? `◎豆瓣链接　${douban_link}\n` : "";
    descr += episodes ? `◎集　　数　${episodes}\n` : "";
    descr += duration ? `◎片　　长　${duration}\n` : "";
    descr += director && director.length > 0 ? `◎导　　演　${director.map(x => x['name']).join(" / ")}\n` : "";
    descr += writer && writer.length > 0 ? `◎编　　剧　${writer.map(x => x['name']).join(" / ")}\n` : "";
    descr += cast && cast.length > 0 ? `◎主　　演　${cast.map(x => x['name']).join("\n" + "　".repeat(4) + "  　").trim()}\n` : "";
    descr += tags && tags.length > 0 ? `\n◎标　　签　${tags.join(" | ")}\n` : "";
    descr += introduction ? `\n◎简　　介\n\n　　${introduction.replace(/\n/g, "\n" + "　".repeat(2))}\n` : "";
    descr += awards ? `\n◎获奖情况\n\n　　${awards.replace(/\n/g, "\n" + "　".repeat(2))}\n` : "";

    data["format"] = descr.trim();
    data["success"] = true; // 更新状态为成功
    return makeJsonResponse(data);
  }
}

async function gen_imdb(sid) {
  let data = {
    site: "imdb",
    sid: sid
  };
  // 处理imdb_id tt\d{7,8} 或者 \d{0,8}
  if (sid.startsWith("tt")) {
    sid = sid.slice(2);
  }

  // 不足7位补齐到7位，如果是7、8位则直接使用
  let imdb_id = "tt" + sid.padStart(7, "0");
  let imdb_url = `https://www.imdb.com/title/${imdb_id}/`;

  let imdb_page_resp = await fetch(imdb_url);
  let imdb_page_raw = await imdb_page_resp.text();

  if (imdb_page_raw.match(/404 Error - IMDb/)) {
    return makeJsonResponse(Object.assign(data, {
      error: NONE_EXIST_ERROR
    }));
  }

  let imdb_release_info_page_req = fetch(`${imdb_url}releaseinfo`)

  let $ = page_parser(imdb_page_raw);

  // 首先解析页面中的json信息，并从中获取数据  `<script type="application/ld+json">...</script>`
  let page_json = JSON.parse($('script[type="application/ld+json"]').html().replace(/\n/ig,''));

  data["imdb_id"] = imdb_id;
  data["imdb_link"] = imdb_url;

  // 处理可以直接从page_json中复制过来的信息
  let copy_items = ["@type", "name", "genre", "contentRating", "datePublished", "description", "duration"];
  for (let i = 0; i < copy_items.length; i++) {
    let copy_item = copy_items[i];
    data[copy_item] = page_json[copy_item];
  }

  data["poster"] = page_json["image"];

  if (data["datePublished"]) {
    data["year"] = data["datePublished"].slice(0, 4);
  }

  let person_items = ["actor", "director", "creator"];
  for (let i = 0; i < person_items.length; i++) {
    let person_item = person_items[i];
    let raw = page_json[person_item];

    if (!raw) continue; // 没有对应直接直接进入下一轮

    // 有时候这个可能为一个dict而不是dict array
    if (!Array.isArray(raw)) {
      raw = [raw];
    }

    // 只要人的（Person），不要组织的（Organization）
    let item_persons = raw.filter((d) => {
      return d["@type"] === "Person";
    });

    if (item_persons.length > 0) {
      data[person_item + "s"] = item_persons.map((d) => {
        delete d["@type"];
        return d;
      });
    }
  }

  data["keywords"] = page_json["keywords"].split(",");
  let aggregate_rating = page_json["aggregateRating"] || {};

  data["imdb_votes"] = aggregate_rating["ratingCount"] || 0;
  data["imdb_rating_average"] = aggregate_rating["ratingValue"] || 0;
  data["imdb_rating"] = `${data["imdb_votes"]}/10 from ${data["imdb_rating_average"]} users`;

  // 解析页面元素
  // 第一部分： Metascore，Reviews，Popularity
  let mrp_bar = $("div.titleReviewBar > div.titleReviewBarItem");
  mrp_bar.each(function () {
    let that = $(this);
    if (that.text().match(/Metascore/)) {
      let metascore_another = that.find("div.metacriticScore");
      if (metascore_another) data["metascore"] = metascore_another.text().trim();
    } else if (that.text().match(/Reviews/)) {
      let reviews_another = that.find("a[href^=reviews]");
      let critic_another = that.find("a[href^=externalreviews]");
      if (reviews_another) data["reviews"] = getNumberFromString(reviews_another.text());
      if (critic_another) data["critic"] = getNumberFromString(critic_another.text());
    } else if (that.text().match(/Popularity/)) {
      data["popularity"] = getNumberFromString(that.text());
    }
  });

  // 第二部分： Details
  let details_another = $("div#titleDetails");
  let title_anothers = details_another.find("div.txt-block");
  let details_dict = {};
  title_anothers.each(function () {
    let title_raw = $(this).text().replace(/\n/ig, " ").replace(/See more »|Show more on {3}IMDbPro »/g, "").trim();
    if (title_raw.length > 0) {
      let title_key = title_raw.split(/: ?/, 1)[0];
      details_dict[title_key] = title_raw.replace(title_key + ":", "").replace(/ {2,}/g, " ").trim();
    }
  });
  data["details"] = details_dict;

  // 请求附属信息
  // 第一部分： releaseinfo
  let imdb_release_info_page_resp = await imdb_release_info_page_req;
  let imdb_release_info_raw = await imdb_release_info_page_resp.text();
  let imdb_release_info = page_parser(imdb_release_info_raw);

  let release_date_items = imdb_release_info("tr.release-date-item");
  let release_date = [],
    aka = [];
  release_date_items.each(function () {
    let that = imdb_release_info(this); // $(this) ?
    let country = that.find("td.release-date-item__country-name");
    let date = that.find("td.release-date-item__date");

    if (country && date) {
      release_date.push({
        country: country.text().trim(),
        date: date.text().trim()
      });
    }
  });
  data["release_date"] = release_date;

  let aka_items = imdb_release_info("tr.aka-item");
  aka_items.each(function () {
    let that = imdb_release_info(this);
    let country = that.find("td.aka-item__name");
    let title = that.find("td.aka-item__title");

    if (country && title) {
      aka.push({
        country: country.text().trim(),
        title: title.text().trim()
      });
    }
  });
  data["aka"] = aka;

  // 生成format
  let descr = (data["poster"] && data["poster"].length > 0) ? `[img]${data["poster"]}[/img]\n\n` : "";
  descr += (data["name"] && data["name"].length > 0) ? `Title: ${data["name"]}\n` : "";
  descr += (data["keywords"] && data["keywords"].length > 0) ? `Keywords: ${data["keywords"].join(", ")}\n` : "";
  descr += (data["datePublished"] && data["datePublished"].length > 0) ? `Date Published: ${data["datePublished"]}\n` : "";
  descr += (data["imdb_rating"] && data["imdb_rating"].length > 0) ? `IMDb Rating: ${data["imdb_rating"]}\n` : "";
  descr += (data["imdb_link"] && data["imdb_link"].length > 0) ? `IMDb Link: ${data["imdb_link"]}\n` : "";
  descr += (data["directors"] && data["directors"].length > 0) ? `Directors: ${data["directors"].map(i => i["name"]).join(" / ")}\n` : "";
  descr += (data["creators"] && data["creators"].length > 0) ? `Creators: ${data["creators"].map(i => i["name"]).join(" / ")}\n` : "";
  descr += (data["actors"] && data["actors"].length > 0) ? `Actors: ${data["actors"].map(i => i["name"]).join(" / ")}\n` : "";
  descr += (data["description"] && data["description"].length > 0) ? `\nIntroduction\n    ${data["description"].replace(/\n/g, "\n" + "　".repeat(2))}\n` : "";

  data["format"] = descr.trim();
  data["success"] = true; // 更新状态为成功
  return makeJsonResponse(data);
}

async function gen_bangumi(sid) {
  let data = {
    site: "bangumi",
    sid: sid
  };

  // 请求页面
  let bangumi_link = `https://bgm.tv/subject/${sid}`;
  let bangumi_page_resp = await fetch(bangumi_link);
  let bangumi_page_raw = await bangumi_page_resp.text();
  if (bangumi_page_raw.match(/呜咕，出错了/)) {
    return makeJsonResponse(Object.assign(data, {
      error: NONE_EXIST_ERROR
    }));
  }

  data["alt"] = bangumi_link;

  // 立即请求附加资源
  let bangumi_characters_req = fetch(`${bangumi_link}/characters`)

  let $ = page_parser(bangumi_page_raw);

  // 对页面进行划区
  let cover_staff_another = $("div#bangumiInfo");
  let cover_another = cover_staff_another.find("a.thickbox.cover");
  let staff_another = cover_staff_another.find("ul#infobox");
  let story_another = $("div#subject_summary");
  // let cast_another = $('div#browserItemList');

  /*  data['cover'] 为向前兼容项，之后均用 poster 表示海报
   *  这里有个问题，就是仍按 img.attr('src') 会取不到值因为 cf-worker中fetch 返回的html片段如下 ： https://pastebin.com/0wPLAf8t
   *  暂时不明白是因为 cf-worker 的问题还是 cf-CDN 的问题，因为直接源代码审查未发现该片段。
   */
  data["cover"] = data["poster"] = cover_another ? ("https:" + cover_another.attr("href")).replace(/\/cover\/[lcmsg]\//, "/cover/l/") : "";
  data["story"] = story_another ? story_another.text().trim() : "";
  data["staff"] = staff_another.find("li").map(function () {
    return $(this).text();
  }).get();

  // ---其他页面信息，但是暂未放入format中

  // 评分信息
  data["bangumi_votes"] = $('span[property="v:votes"]').text();
  data["bangumi_rating_average"] = $('div.global_score > span[property="v:average"]').text();

  // 标签
  data["tags"] = $('#subject_detail > div.subject_tag_section > div > a > span').map(function () {
    return $(this).text()
  }).get()

  // ---其他暂未放入format的页面信息结束

  // 角色信息
  let bangumi_characters_resp = await bangumi_characters_req;
  let bangumi_characters_page_raw = await bangumi_characters_resp.text();
  let bangumi_characters_page = page_parser(bangumi_characters_page_raw);
  let cast_actors = bangumi_characters_page("div#columnInSubjectA > div.light_odd > div.clearit");

  data["cast"] = cast_actors.map(function () {
    let tag = bangumi_characters_page(this);
    let h2 = tag.find("h2");
    let char = (h2.find("span.tip").text() || h2.find("a").text()).replace(/\//, "").trim();
    let cv = tag.find("div.clearit > p").map(function () {
      let p = bangumi_characters_page(this);
      return (p.find("small") || p.find("a")).text().trim();
    }).get().join("，");
    return `${char}: ${cv}`;
  }).get();

  // 生成format
  let descr = (data["poster"] && data["poster"].length > 0) ? `[img]${data["poster"]}[/img]\n\n` : "";
  descr += (data["story"] && data["story"].length > 0) ? `[b]Story: [/b]\n\n${data["story"]}\n\n` : "";
  // 中文名、话数、放送开始、放送星期 不视为staff列表项
  descr += (data["staff"] && data["staff"].length > 0) ? `[b]Staff: [/b]\n\n${data["staff"].filter(d => {
    return !/^(中文名|话数|放送开始|放送星期)/.test(d)
  }).slice(0, 15).join("\n")}\n\n` : "";
  // 读取前9项cast信息
  descr += (data["cast"] && data["cast"].length > 0) ? `[b]Cast: [/b]\n\n${data["cast"].slice(0, 9).join("\n")}\n\n` : "";
  descr += (data["alt"] && data["alt"].length > 0) ? `(来源于 ${data["alt"]} )\n` : "";

  data["format"] = descr.trim();
  data["success"] = true; // 更新状态为成功
  return makeJsonResponse(data);
}

async function gen_steam(sid) {
  let data = {
    site: "steam",
    sid: sid
  };

  let steam_page_resp = await fetch(`https://store.steampowered.com/app/${sid}/?l=schinese`, {
    redirect: "manual",
    headers: { // 使用Cookies绕过年龄检查和成人内容提示，并强制中文
      "Cookies": "lastagecheckage=1-January-1975; birthtime=157737601; mature_content=1; wants_mature_content=1; Steam_Language=schinese"
    }
  });

  // 不存在的资源会被302到首页，故检查标题
  if (steam_page_resp.status === 302) {
    return makeJsonResponse(Object.assign(data, {
      error: NONE_EXIST_ERROR
    }));
  }

  data["steam_id"] = sid;

  // 立即请求附加资源
  let steamcn_api_req = fetch(`https://steamdb.keylol.com/app/${sid}/data.js?v=38`);
  let $ = page_parser(await steam_page_resp.text());

  // 从网页中定位数据
  let name_anchor = $("div.apphub_AppName") || $("span[itemprop=\"name\"]"); // 游戏名
  let cover_anchor = $("img.game_header_image_full[src]"); // 游戏封面图
  let detail_anchor = $("div.details_block"); // 游戏基本信息
  let linkbar_anchor = $("a.linkbar"); // 官网
  let language_anchor = $("table.game_language_options tr[class!=unsupported]"); // 支持语言
  let tag_anchor = $("a.app_tag"); // 标签
  let rate_anchor = $("div.user_reviews_summary_row"); // 游戏评价
  let descr_anchor = $("div#game_area_description"); // 游戏简介
  let sysreq_anchor = $("div.sysreq_contents > div.game_area_sys_req"); // 系统需求
  let screenshot_anchor = $("div.screenshot_holder a"); // 游戏截图

  data["cover"] = data["poster"] = cover_anchor ? cover_anchor.attr("src").replace(/^(.+?)(\?t=\d+)?$/, "$1") : "";
  data["name"] = name_anchor ? name_anchor.text().trim() : "";
  data["detail"] = detail_anchor ?
    detail_anchor.eq(0).text()
    .replace(/:[ 	\n]+/g, ": ")
    .split("\n")
    .map(x => x.trim())
    .filter(x => x.length > 0)
    .join("\n") : "";
  data["tags"] = tag_anchor ? tag_anchor.map(function () {
    return $(this).text().trim();
  }).get() : [];
  data["review"] = rate_anchor ? rate_anchor.map(function () {
    return $(this).text().replace("：", ":").replace(/[ 	\n]{2,}/ig, " ").trim();
  }).get() : [];
  if (linkbar_anchor && linkbar_anchor.text().search("访问网站")) {
    data["linkbar"] = linkbar_anchor.attr("href").replace(/^.+?url=(.+)$/, "$1");
  }

  const lag_checkcol_list = ["界面", "完全音频", "字幕"];
  data["language"] = language_anchor ?
    language_anchor
    .slice(1, 4) // 不要首行，不要不支持行 外的前三行
    .map(function () {
      let tag = $(this);
      let tag_td_list = tag.find("td");
      let lag_support_checkcol = [];
      let lag = tag_td_list.eq(0).text().trim();

      for (let i = 0; i < lag_checkcol_list.length; i++) {
        let j = tag_td_list.eq(i + 1);
        if (j.text().search("✔")) {
          lag_support_checkcol.push(lag_checkcol_list[i]);
        }
      }

      return `${lag}${lag_support_checkcol.length > 0 ? ` (${lag_support_checkcol.join(", ")})` : ""}`;
    }).get() : [];

  data["descr"] = descr_anchor ? html2bbcode(descr_anchor.html()).replace("[h2]关于这款游戏[/h2]", "").trim() : "";
  data["screenshot"] = screenshot_anchor ? screenshot_anchor.map(function () {
    let dic = $(this);
    return dic.attr("href").replace(/^.+?url=(http.+?)\.[\dx]+(.+?)(\?t=\d+)?$/, "$1$2");
  }).get() : [];

  const os_dict = {
    "win": "Windows",
    "mac": "Mac OS X",
    "linux": "SteamOS + Linux"
  };
  data["sysreq"] = sysreq_anchor ? sysreq_anchor.map(function () {
    let tag = $(this);
    let os_type = os_dict[tag.attr("data-os")];

    let clone_tag = tag.clone();
    clone_tag.html(tag.html().replace(/<br>/ig, "[br]"));

    let sysreq_content = clone_tag
      .text()
      .split("\n").map(x => x.trim()).filter(x => x.length > 0).join("\n\n") // 处理最低配置和最高配置之间的空白行
      .split("[br]").map(x => x.trim()).filter(x => x.length > 0).join("\n"); // 处理配置内的分行

    return `${os_type}\n${sysreq_content}`;
  }).get() : [];

  // 处理附加资源
  let steamcn_api_resp = await steamcn_api_req;
  let steamcn_api_jsonp = await steamcn_api_resp.text();
  let steamcn_api_json = jsonp_parser(steamcn_api_jsonp);
  if (steamcn_api_json["name_cn"]) data["name_chs"] = steamcn_api_json["name_cn"];

  // 生成format
  let descr = (data["poster"] && data["poster"].length > 0) ? `[img]${data["poster"]}[/img]\n\n` : "";
  descr += "【基本信息】\n\n"; // 基本信息为原来的baseinfo块
  descr += (data["name_chs"] && data["name_chs"].length > 0) ? `中文名: ${data["name_chs"]}\n` : "";
  descr += (data["detail"] && data["detail"].length > 0) ? `${data["detail"]}\n` : "";
  descr += (data["linkbar"] && data["linkbar"].length > 0) ? `官方网站: ${data["linkbar"]}\n` : "";
  descr += (data["steam_id"] && data["steam_id"].length > 0) ? `Steam页面: https://store.steampowered.com/app/${data["steam_id"]}/\n` : "";
  descr += (data["language"] && data["language"].length > 0) ? `游戏语种: ${data["language"].join(" | ")}\n` : "";
  descr += (data["tags"] && data["tags"].length > 0) ? `标签: ${data["tags"].join(" | ")}\n` : "";
  descr += (data["review"] && data["review"].length > 0) ? `\n${data["review"].join("\n")}\n` : "";
  descr += "\n";
  descr += (data["descr"] && data["descr"].length > 0) ? `【游戏简介】\n\n${data["descr"]}\n\n` : "";
  descr += (data["sysreq"] && data["sysreq"].length > 0) ? `【配置需求】\n\n${data["sysreq"].join("\n")}\n\n` : "";
  descr += (data["screenshot"] && data["screenshot"].length > 0) ? `【游戏截图】\n\n${data["screenshot"].map(x => `[img]${x}[/img]`).join("\n")}\n\n` : "";

  data["format"] = descr.trim();
  data["success"] = true; // 更新状态为成功
  return makeJsonResponse(data);
}

async function gen_indienova(sid) {
  let data = {
    site: "indienova",
    sid: sid
  };

  let indienova_page_resp = await fetch(`https://indienova.com/game/${sid}`);
  let indienova_page_raw = await indienova_page_resp.text();

  // 检查标题看对应资源是否存在
  if (indienova_page_raw.match(/出现错误/)) {
    return makeJsonResponse(Object.assign(data, {
      error: NONE_EXIST_ERROR
    }));
  }

  let $ = page_parser(indienova_page_raw);

  data["poster"] = data["cover"] = $("div.cover-image img").attr("src"); // 提出封面链接
  data["chinese_title"] = $("title").text().split("|")[0].split("-")[0].trim(); // 提出标题部分

  let title_field = $("div.title-holder"); // 提取出副标部分
  data["another_title"] = title_field.find("h1 small") ? title_field.find("h1 small").text().trim() : "";
  data["english_title"] = title_field.find("h1 span") ? title_field.find("h1 span").text().trim() : "";
  data["release_date"] = title_field.find("p.gamedb-release").text().trim();

  // 提取链接信息
  let link_field = $("div#tabs-link a.gamedb-link");
  if (link_field.length > 0) {
    let links = {};
    link_field.each(function () {
      let that = $(this);
      let site = that.text().trim();
      links[site] = that.attr("href");
    });
    data["links"] = links;
  }

  // 提取简介、类型信息
  let intro_field = $("#tabs-intro");
  data["intro"] = intro_field.find("div.bottommargin-sm").text().trim();

  let tt = intro_field.find("p.single-line");
  if (tt.length > 0) {
    data["intro_detail"] = tt.map(function () {
      return $(this).text().replace(/[ \n]+/ig, " ").replace(/,/g, "/").trim();
    }).get();
  }

  // 提取详细介绍 在游戏无详细介绍时用简介代替
  let descr_field = $("article");
  data["descr"] = descr_field.length > 0 ? descr_field.text().replace("……显示全部", "").trim() : data["intro"];

  // 提取评分信息
  let rating_field = $("div#scores text").map(function () {
    return $(this).text();
  }).get();
  data["rate"] = `${rating_field[0]}:${rating_field[1]} / ${rating_field[2]}:${rating_field[3]}`;

  // 提取制作与发行商
  let pubdev = $("div#tabs-devpub ul[class^=\"db-companies\"]");
  // noinspection JSUnusedLocalSymbols
  data["dev"] = pubdev.eq(0).text().trim().split("\n").map(function (value, index, array) {
    return value.trim();
  });
  // noinspection JSUnusedLocalSymbols
  data["pub"] = pubdev.length === 2 ? pubdev.eq(1).text().trim().split("\n").map(function (value, index, array) {
    return value.trim();
  }) : [];

  // 提取图片列表
  data["screenshot"] = $("li.slide img").map(function () {
    return $(this).attr("src");
  }).get();

  // 提取标签信息
  let cat_field = $("div.indienova-tags.gamedb-tags");
  let cat = cat_field ? cat_field.text().trim().split("\n").map(x => x.trim()) : [];
  // 对cat进行去重并移除 "查看全部 +"
  data["cat"] = cat.filter(function (item, pos) {
    return cat.indexOf(item) === pos && item !== "查看全部 +";
  });

  // 提取分级信息
  let level_field = $("h4:contains(\"分级\") + div.bottommargin-sm");
  data["level"] = level_field ? level_field.find("img").map(function () {
    return $(this).attr("src");
  }).get() : [];

  // 提取价格信息
  let price_fields = $("ul.db-stores");
  data["price"] = price_fields ? price_fields.find("li").map(function () {
    let price_field = $(this).find("a > div"); // 里面依次为3个div，分别为 store, platform , price
    let store = price_field.eq(0).text().trim();
    //let platform = price_field.eq(1).text().trim();  // 均为图片，无内容
    let price = price_field.eq(2).text().trim().replace(/[ \n]{2,}/, " ");
    return `${store}：${price}`;
  }).get() : [];

  // 生成format
  let descr = data["cover"] ? `[img]${data["cover"]}[/img]\n\n` : "";
  descr += "【基本信息】\n\n"; // 基本信息为原来的baseinfo块
  descr += (data["chinese_title"] && data["chinese_title"].length > 0) ? `中文名称：${data["chinese_title"]}\n` : "";
  descr += (data["english_title"] && data["english_title"].length > 0) ? `英文名称：${data["english_title"]}\n` : "";
  descr += (data["another_title"] && data["another_title"].length > 0) ? `其他名称：${data["another_title"]}\n` : "";
  descr += (data["release_date"] && data["release_date"].length > 0) ? `发行时间：${data["release_date"]}\n` : "";
  descr += (data["rate"] && data["rate"].length > 0) ? `评分：${data["rate"]}\n` : "";
  descr += (data["dev"] && data["dev"].length > 0) ? `开发商：${data["dev"].join(" / ")}\n` : "";
  descr += (data["pub"] && data["pub"].length > 0) ? `发行商：${data["pub"].join(" / ")}\n` : "";
  descr += (data["intro_detail"] && data["intro_detail"].length > 0) ? `${data["intro_detail"].join("\n")}\n` : "";
  descr += (data["cat"] && data["cat"].length > 0) ? `标签：${data["cat"].slice(0, 8).join(" | ")}\n` : "";
  if ((data["links"] && data["links"].length > 0)) {
    let format_links = [];
    for (let [key, value] of Object.entries(data["links"])) {
      format_links.push(`[url=${value}]${key}[/url]`);
    }
    descr += `链接地址：${format_links.join("  ")}\n`;
  }
  descr += (data["price"] && data["price"].length > 0) ? `价格信息：${data["price"].join(" / ")}\n` : "";
  descr += "\n";
  descr += (data["descr"] && data["descr"].length > 0) ? `【游戏简介】\n\n${data["descr"]}\n\n` : "";
  descr += (data["screenshot"] && data["screenshot"].length > 0) ? `【游戏截图】\n\n${data["screenshot"].map(x => `[img]${x}[/img]`).join("\n")}\n\n` : "";
  descr += (data["level"] && data["level"].length > 0) ? `【游戏评级】\n\n${data["level"].map(x => `[img]${x}[/img]`).join("\n")}\n\n` : "";

  data["format"] = descr.trim();
  data["success"] = true; // 更新状态为成功
  return makeJsonResponse(data);
}

async function gen_epic(sid) {
  let data = {
    site: "epic",
    sid: sid
  };

  let epic_api_resp = await fetch(`https://store-content.ak.epicgames.com/api/zh-CN/content/products/${sid}`);
  if (epic_api_resp.status === 404) { // 当接口返回404时内容不存在，200则继续解析
    return makeJsonResponse(Object.assign(data, {
      error: NONE_EXIST_ERROR
    }));
  }

  let epic_api_json = await epic_api_resp.json();

  // 从顶层字典中获得page
  let page = epic_api_json["pages"][0];

  data["name"] = page["productName"]; // 游戏名称
  data["epic_link"] = `https://www.epicgames.com/store/zh-CN/product/${sid}/home`; // 商店链接

  data["desc"] = page["data"]["about"]["description"]; // 游戏简介
  data["poster"] = data["logo"] = page["data"]["hero"]["logoImage"]["src"]; // 游戏logo
  data["screenshot"] = (page["data"]["gallery"]["galleryImages"] || []).map(x => x["src"]); // 游戏截图

  let requirements = page["data"]["requirements"] || [];

  // 语言
  let languages = [];
  for (let i = 0; i < requirements["languages"].length; i++) {
    let lang = requirements["languages"][i];
    if (lang.search(':') === -1 && lang.search("：") === -1 && languages.length) {
      // ['语音：英语', '法语', '德语', ..., '文本：繁体中文、简体中文', ' 2020 年 1 月 30 日即将上线：日语']
      let last = languages.length - 1;
      languages[last] += `、${lang}`;
    } else if (lang.search('-') > -1) {
      // ['语音：英语、法语、意大利语、德语、西班牙语、日语、韩语、简体中文 - 文本：俄语、葡萄牙语（巴西）']
      let l = lang.split('-');
      for (let j = 0; j < l.length; j++) {
        languages.push(l[j].trim());
      }
    } else {
      // 正常情况
      languages.push(lang);
    }
  }
  data["language"] = languages;

  // 最低配置 推荐配置 评级
  data["min_req"] = {};
  data["max_req"] = {};
  requirements["systems"].forEach(function (i) {
    let systemType = i["systemType"];
    let details = i["details"];
    data["min_req"][systemType] = details.map(x => `${x["title"]}: ${x["minimum"] || ''}`);
    data["max_req"][systemType] = details.map(x => `${x["title"]}: ${x["recommended"] || ''}`);
  });
  data["level"] = requirements["legalTags"].map(x => x["src"]);

  // 生成format
  let descr = (data["logo"] && data["logo"].length > 0) ? `[img]${data["logo"]}[/img]\n\n` : "";
  descr += "【基本信息】\n\n"; // 基本信息为原来的baseinfo块
  descr += (data["name"] && data["name"].length > 0) ? `游戏名称：${data["name"]}\n` : "";
  descr += (data["epic_link"] && data["epic_link"].length > 0) ? `商店链接：${data["epic_link"]}\n` : "";
  descr += "\n";
  descr += (data["language"] && data["language"].length > 0) ? `【支持语言】\n\n${data["language"].join("\n")}\n\n` : "";
  descr += (data["desc"] && data["desc"].length > 0) ? `【游戏简介】\n\n${data["desc"]}\n\n` : "";

  let req_list = {
    "min_req": "【最低配置】",
    "max_req": "【推荐配置】"
  };
  for (let req in req_list) {
    if (Object.entries(data[req]).length === 0 && data[req].constructor === Object) continue;
    descr += `${req_list[req]}\n\n`;
    for (let system in data[req]) {
      // noinspection JSUnfilteredForInLoop
      descr += `${system}\n${data[req][system].join("\n")}\n`;
    }
    descr += "\n\n";
  }
  descr += (data["screenshot"] && data["screenshot"].length > 0) ? `【游戏截图】\n\n${data["screenshot"].map(x => `[img]${x}[/img]`).join("\n")}\n\n` : "";
  descr += (data["level"] && data["level"].length > 0) ? `【游戏评级】\n\n${data["level"].map(x => `[img]${x}[/img]`).join("\n")}\n\n` : "";

  data["format"] = descr.trim();
  data["success"] = true; // 更新状态为成功
  return makeJsonResponse(data);
}

async function makeIndexResponse() {
  return new Response(INDEX, {
    headers: {
      'Content-Type': 'text/html'
    },
  });
}

const INDEX = `
INDEX_HTML_REPLACE
`;
