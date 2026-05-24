const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (!DEEPSEEK_API_KEY) {
    return res.status(500).json({ error: '服务端配置错误：DEEPSEEK_API_KEY 未设置' });
  }

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: '仅支持 POST 请求' });
  }

  const { videoUrl, maxComments = 100 } = req.body || {};

  if (!videoUrl) {
    return res.status(400).json({ error: '请提供抖音视频链接' });
  }

  try {
    const awemeId = await extractAwemeId(videoUrl);
    if (!awemeId) {
      return res.status(400).json({ error: '无法解析视频链接，请检查链接是否正确' });
    }

    const comments = await fetchDouyinComments(awemeId, maxComments);
    if (!comments || comments.length === 0) {
      return res.status(404).json({
        error: '未获取到评论。可能原因：1) 视频评论区已关闭  2) 该视频暂无评论  3) 抖音接口限制，请稍后重试',
        videoId: awemeId,
        success: false,
      });
    }

    const analysis = await analyzeBirthdays(comments, DEEPSEEK_API_KEY);

    const stats = calculateStats(comments, analysis);

    return res.status(200).json({
      success: true,
      videoId: awemeId,
      totalComments: comments.length,
      comments: comments.slice(0, 100),
      birthdays: analysis,
      stats,
    });
  } catch (err) {
    console.error('分析失败:', err);
    return res.status(500).json({
      error: '分析失败: ' + (err.message || '未知错误'),
    });
  }
}

async function extractAwemeId(url) {
  url = url.trim();

  const directMatch = url.match(/douyin\.com\/video\/(\d+)/);
  if (directMatch) return directMatch[1];

  try {
    const parsed = new URL(url);
    const modalId = parsed.searchParams.get('modal_id');
    if (modalId && /^\d+$/.test(modalId)) return modalId;
  } catch {}

  const shortMatch = url.match(/v\.douyin\.com\/([\w-]+)/);
  if (shortMatch) {
    try {
      const resp = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      const finalUrl = resp.url;
      const idMatch = finalUrl.match(/video\/(\d+)/);
      if (idMatch) return idMatch[1];
      const modalMatch = finalUrl.match(/modal_id=(\d+)/);
      if (modalMatch) return modalMatch[1];
    } catch {
      return null;
    }
  }

  const genericMatch = url.match(/(?:aweme_id|video_id|modal_id)=(\d+)/);
  if (genericMatch) return genericMatch[1];

  return null;
}

async function fetchDouyinComments(awemeId, maxCount) {
  let comments = await tryApiV1(awemeId, maxCount);
  if (comments.length > 0) return comments;

  comments = await tryApiV2(awemeId, maxCount);
  if (comments.length > 0) return comments;

  comments = await tryScrapePage(awemeId, maxCount);

  return comments;
}

async function tryScrapePage(awemeId, maxCount) {
  try {
    const resp = await fetch(`https://www.douyin.com/video/${awemeId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });

    if (!resp.ok) return [];

    const html = await resp.text();

    const jsonMatch = html.match(/<script[^>]*id="RENDER_DATA"[^>]*>([\s\S]*?)<\/script>/);
    if (jsonMatch) {
      try {
        const decoded = decodeURIComponent(jsonMatch[1]);
        const renderData = JSON.parse(decoded);
        const comments = extractCommentsFromRenderData(renderData, maxCount);
        if (comments.length > 0) return comments;
      } catch {}
    }

    const serverData = html.match(/window\._ROUTER_DATA\s*=\s*({[\s\S]*?})<\/script>/);
    if (serverData) {
      try {
        const data = JSON.parse(serverData[1]);
        const comments = extractCommentsFromSSR(data, maxCount);
        if (comments.length > 0) return comments;
      } catch {}
    }
  } catch {}

  return [];
}

function extractCommentsFromRenderData(data, maxCount) {
  const result = [];
  try {
    let commentList = null;
    const search = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        for (const item of obj) search(item);
        return;
      }
      if (obj.comments && Array.isArray(obj.comments)) {
        commentList = obj.comments;
        return;
      }
      if (obj.comment && Array.isArray(obj.comment)) {
        commentList = obj.comment;
        return;
      }
      for (const key of Object.keys(obj)) {
        if (key.startsWith('__')) continue;
        search(obj[key]);
      }
    };
    search(data);

    if (commentList) {
      for (const c of commentList.slice(0, maxCount)) {
        result.push({
          text: c.text || '',
          user: c.user?.nickname || c.user_name || '匿名',
          diggCount: c.digg_count || 0,
          createTime: c.create_time || 0,
          ipLabel: c.ip_label || c.user?.ip_location || '',
          replyCount: c.reply_comment_total || 0,
        });
      }
    }
  } catch {}
  return result;
}

function extractCommentsFromSSR(data, maxCount) {
  const result = [];
  try {
    const search = (obj, depth = 0) => {
      if (!obj || typeof obj !== 'object' || depth > 20) return;
      if (Array.isArray(obj)) {
        for (const item of obj) search(item, depth + 1);
        return;
      }
      if (obj.commentList && Array.isArray(obj.commentList)) {
        for (const c of obj.commentList.slice(0, maxCount)) {
          result.push({
            text: c.text || c.content || '',
            user: c.user?.nickname || c.author?.name || '匿名',
            diggCount: c.digg_count || c.likeCount || 0,
            createTime: c.create_time || c.createTime || 0,
            ipLabel: c.ip_label || c.user?.ip_location || '',
            replyCount: c.reply_comment_total || c.replyCount || 0,
          });
        }
        return;
      }
      for (const key of Object.keys(obj)) {
        if (key.startsWith('__')) continue;
        search(obj[key], depth + 1);
      }
    };
    search(data);
  } catch {}
  return result;
}

async function tryApiV1(awemeId, maxCount) {
  const allComments = [];
  let cursor = 0;
  const limit = Math.min(maxCount, 500);

  while (allComments.length < limit) {
    try {
      const url = `https://www.douyin.com/aweme/v1/web/comment/list/?` +
        new URLSearchParams({
          aweme_id: awemeId,
          cursor: String(cursor),
          count: '20',
          device_platform: 'webapp',
          aid: '6383',
          channel: 'channel_pc_web',
          pc_client_type: '1',
          version_code: '190400',
          version_name: '19.4.0',
          cookie_enabled: 'true',
          screen_width: '1920',
          screen_height: '1080',
          browser_language: 'zh-CN',
          browser_platform: 'Win32',
          browser_name: 'Chrome',
          browser_version: '120.0.0.0',
        });

      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': `https://www.douyin.com/video/${awemeId}`,
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Cookie': `ttwid=1|${Date.now()}|...; odin_tt=...; passport_csrf_token=...`,
        },
      });

      if (!resp.ok) break;

      const data = await resp.json();
      const commentList = data?.comments || data?.data?.comments || [];
      if (commentList.length === 0) break;

      for (const c of commentList) {
        allComments.push({
          text: c.text || '',
          user: c.user?.nickname || '匿名',
          diggCount: c.digg_count || 0,
          createTime: c.create_time || 0,
          replyCount: c.reply_comment_total || 0,
        });
      }

      if (!data.has_more && !data.hasMore) break;
      cursor = data.cursor || cursor + 20;
    } catch {
      break;
    }
  }

  return allComments;
}

async function tryApiV2(awemeId, maxCount) {
  const allComments = [];
  let cursor = 0;
  const limit = Math.min(maxCount, 500);

  while (allComments.length < limit) {
    try {
      const url = `https://www.iesdouyin.com/web/api/v2/comment/list/?` +
        new URLSearchParams({
          aweme_id: awemeId,
          cursor: String(cursor),
          count: '20',
        });

      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://www.douyin.com/',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      });

      if (!resp.ok) break;

      const data = await resp.json();
      const commentList = data?.comments || data?.data?.comments || [];
      if (commentList.length === 0) break;

      for (const c of commentList) {
        allComments.push({
          text: c.text || '',
          user: c.user?.nickname || '匿名',
          diggCount: c.digg_count || 0,
          createTime: c.create_time || 0,
          replyCount: c.reply_comment_total || 0,
        });
      }

      if (!data.has_more && !data.hasMore) break;
      cursor = data.cursor || cursor + 20;
    } catch {
      break;
    }
  }

  return allComments;
}

async function analyzeBirthdays(comments, apiKey) {
  if (!comments || comments.length === 0) return [];

  const allBirthdays = [];

  const batchSize = 80;
  for (let i = 0; i < comments.length; i += batchSize) {
    const batch = comments.slice(i, i + batchSize);

    const localResults = localExtract(batch, i);
    for (const r of localResults) {
      allBirthdays.push(r);
    }

    const foundIndexes = new Set(localResults.map(r => r.commentIndex));

    const remainingLines = [];
    for (let bi = 0; bi < batch.length; bi++) {
      const idx = i + bi + 1;
      if (!foundIndexes.has(idx)) {
        remainingLines.push(`[${idx}] ${batch[bi].text}`);
      }
    }

    if (remainingLines.length > 0) {
      const aiResults = await callDeepSeek(remainingLines.join('\n'), apiKey);
      for (const r of aiResults) {
        allBirthdays.push(r);
      }
    }
  }

  return allBirthdays;
}

function localExtract(batch, batchOffset) {
  const results = [];

  for (let bi = 0; bi < batch.length; bi++) {
    const commentIndex = batchOffset + bi + 1;
    const text = batch[bi].text || '';

    const extracted = extractDateFromText(text, commentIndex);
    if (extracted) {
      results.push(extracted);
      continue;
    }

    const wishResult = extractWish(text, commentIndex);
    if (wishResult) {
      results.push(wishResult);
    }
  }

  return results;
}

function extractDateFromText(text, commentIndex) {
  if (!text) return null;

  const clean = text.replace(/[@#＠＃]+/g, '').replace(/https?:\/\/\S+/g, '');

  const patterns = [
    /(\d{1,2})月(\d{1,2})[日号]?/,
    /(\d{1,2})[\.\-\/](\d{1,2})(?![0-9年月日号])/,
    /(\d{1,2})[\.\-\/](\d{1,2})[日号]/,
    /(\d{1,2})[：:](\d{1,2})/,
    /[^0-9](\d{2})(\d{2})[^0-9]/,
    /^(\d{2})(\d{2})$/,
  ];

  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (match) {
      const month = parseInt(match[1], 10);
      const day = parseInt(match[2], 10);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        if (!(month === 2 && day > 29) && !([4, 6, 9, 11].includes(month) && day > 30)) {
          return {
            commentIndex,
            date: `${month}月${day}日`,
            type: 'birthday',
            originalText: text,
          };
        }
      }
    }
  }

  const standaloneMatch = clean.match(/(?:^|[\s,，、。！？🎂🎉🎁❤✨💕\]])([01]\d)([0-3]\d)(?:$|[\s,，、。！？🎂🎉🎁❤✨💕\[])/);
  if (standaloneMatch) {
    const month = parseInt(standaloneMatch[1], 10);
    const day = parseInt(standaloneMatch[2], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      if (!(month === 2 && day > 29) && !([4, 6, 9, 11].includes(month) && day > 30)) {
        return {
          commentIndex,
          date: `${month}月${day}日`,
          type: 'birthday',
          originalText: text,
        };
      }
    }
  }

  return null;
}

function extractWish(text, commentIndex) {
  if (!text) return null;

  const wishPatterns = [
    /生日[快乐快快]/,
    /生[日快]/,
    /破蛋[日快乐]/,
    /[Hh]appy\s*[Bb]irthday/,
    /诞辰/,
    /庆生/,
  ];

  for (const pattern of wishPatterns) {
    if (pattern.test(text)) {
      return {
        commentIndex,
        date: '',
        type: 'wish',
        originalText: text,
      };
    }
  }

  return null;
}

async function callDeepSeek(commentsText, apiKey) {
  if (!commentsText || commentsText.trim().length === 0) return [];

  const prompt = `你是抖音评论生日识别专家。识别以下评论中的生日信息。

识别规则（按优先级）：
⭐ 1. 四位数字 = 生日（抖音最常见！）：
   "0214"→"2月14日", "1201"→"12月1日", "0229"→"2月29日"
   前两位01-12=月份，后两位01-31=日期。即使被emoji包围也识别。
⭐ 2. 中文日期格式："12月25日"、"1月1号"、"12.25"、"12-25"、"12/25"
⭐ 3. 生日关键词附近数字："生日0214"、"我生日是5月20"
⭐ 4. 生日祝福无日期→type="wish", date=""："生日快乐"、"生快"、"happy birthday"
   但如果祝福旁有数字，优先提取数字作为date
⭐ 5. 星座→type="zodiac", date=星座名：天蝎座、双子座...
⭐ 6. 年龄+生日组合："03年"、"我03的"、"05的" → 结合数字推断

重要排除规则：
- 手机号、QQ号、微信号中的数字 NOT 生日
- 年份(19xx/20xx) NOT 生日日期
- 商品编号、价格 NOT 生日
- 楼层、点赞数 NOT 生日

每条结果格式：
{"commentIndex":数字,"date":"X月X日","type":"birthday|wish|zodiac","originalText":"原文"}
无日期时date可为""。
严格返回JSON数组，无内容返回[]。

${commentsText}`;

  try {
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: '你是专业的抖音评论生日识别AI。核心能力：从短文本中识别四位数字(MMDD)生日、中文日期表达、星座提及。排除手机号/QQ号/价格等干扰。只返回JSON数组。',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.05,
        max_tokens: 4096,
        top_p: 0.9,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('DeepSeek API 错误:', resp.status, errText.substring(0, 200));
      return [];
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '[]';

    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const results = JSON.parse(jsonMatch[0]);

    const validated = [];
    for (const r of results) {
      if (typeof r.commentIndex !== 'number') continue;
      if (r.type === 'birthday' && !r.date) continue;
      validated.push(r);
    }

    return validated;
  } catch (err) {
    console.error('DeepSeek 调用失败:', err.message);
    return [];
  }
}

function calculateStats(comments, birthdays) {
  const totalComments = comments.length;
  const totalBirthdayMentions = birthdays.length;

  const dateCounts = {};
  for (const b of birthdays) {
    if (b.date) {
      dateCounts[b.date] = (dateCounts[b.date] || 0) + 1;
    }
  }

  const topDates = Object.entries(dateCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([date, count]) => ({ date, count }));

  const typeCounts = { birthday: 0, zodiac: 0, wish: 0 };
  for (const b of birthdays) {
    if (typeCounts[b.type] !== undefined) {
      typeCounts[b.type]++;
    }
  }

  const mentionRate = totalComments > 0
    ? ((totalBirthdayMentions / totalComments) * 100).toFixed(2)
    : '0.00';

  return {
    totalComments,
    totalBirthdayMentions,
    mentionRate: parseFloat(mentionRate),
    topDates,
    typeBreakdown: typeCounts,
  };
}
