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

  const batchSize = 100;
  const allBirthdays = [];

  for (let i = 0; i < comments.length; i += batchSize) {
    const batch = comments.slice(i, i + batchSize);
    const batchTexts = batch.map((c, idx) => `[${i + idx + 1}] ${c.text}`).join('\n');

    const result = await callDeepSeek(batchTexts, apiKey);
    if (result && result.length > 0) {
      allBirthdays.push(...result);
    }
  }

  return allBirthdays;
}

async function callDeepSeek(commentsText, apiKey) {
  const prompt = `你是一个生日日期识别助手。分析以下抖音评论内容，找出所有包含生日相关信息的评论。

识别规则（按优先级）：
1. ⭐ 四位数字生日（最常见！）：如 "0214"、"1201"、"0315"，前两位是月份，后两位是日期。
   例如 "0214" → "2月14日"，"1201" → "12月1日"，"0125" → "1月25日"，"1128" → "11月28日"
   ⚠️ 重要：只要评论中出现形如 XXXX 的四位数字（且前两位01-12，后两位01-31），就应当识别为生日！
2. 带分隔符的生日："12-25"、"12/25"、"12.25"、"12：25" → "12月25日"
3. 明显的生日日期："12月25日"、"1月1日" 
4. 生日描述："我生日"、"我的生日"、"破蛋日"、"生日是" 后面跟着的数字或日期
5. 生日祝福："生日快乐"、"祝你生日快乐"、"生快"、"生日快" → type为"wish"，date可用上下文中推断的日期或空字符串
6. 星座相关："天蝎座"、"处女座" → type为"zodiac"，date填星座名
7. 年份+生日："03年"、"2003"、"03的" 结合上下文识别生日

特殊情况：
- "0229" → "2月29日"（闰年生日）
- 数字出现在表情符号中间也识别，如 "🎂0214🎂"
- 如果评论是纯数字如 "0214" 也要识别

对于每条匹配的评论，提取：
- "commentIndex": 评论序号（数字）
- "date": 提取到的日期（格式统一为 "X月X日"，如 "2月14日"）
- "type": "birthday"（明确生日日期）、"wish"（生日祝福）、"zodiac"（星座）
- "originalText": 评论原文

请严格以 JSON 数组格式返回，不要包含其他内容：
[
  { "commentIndex": 1, "date": "2月14日", "type": "birthday", "originalText": "0214" }
]

如果没有找到任何生日相关信息，返回空数组 []。

评论内容：
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
          { role: 'system', content: '你是一个精确的日期识别助手。尤其擅长识别抖音评论中的四位数字生日（如0214表示2月14日）。只返回JSON格式数据。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 4096,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('DeepSeek API 错误:', resp.status, errText);
      return [];
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '[]';

    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const aiResults = JSON.parse(jsonMatch[0]);

    const regexResults = regexExtractBirthdays(commentsText, aiResults.length);

    const merged = [...aiResults];
    for (const r of regexResults) {
      const exists = merged.some(m => m.commentIndex === r.commentIndex);
      if (!exists) merged.push(r);
    }

    return merged;
  } catch (err) {
    console.error('DeepSeek 调用失败:', err);
    return [];
  }
}

function regexExtractBirthdays(commentsText, aiCount) {
   const results = [];
   const lines = commentsText.split('\n');

   for (const line of lines) {
     const idxMatch = line.match(/^\[(\d+)\]/);
     if (!idxMatch) continue;
     const commentIndex = parseInt(idxMatch[1], 10);
     const text = line.replace(/^\[\d+\]\s*/, '').trim();

     const allDigits = [...text.matchAll(/\b(\d{4})\b/g)];

     for (const match of allDigits) {
       const digits = match[1];
       const month = parseInt(digits.substring(0, 2), 10);
       const day = parseInt(digits.substring(2, 4), 10);
       if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
         results.push({ commentIndex, date: `${month}月${day}日`, type: 'birthday', originalText: text });
         break;
       }
     }
   }

   const maxExtra = Math.max(0, 50 - aiCount);
   return results.slice(0, maxExtra);
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
