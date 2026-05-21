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
      return res.status(404).json({ error: '未获取到评论，视频可能不存在或评论已关闭' });
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

  const shortMatch = url.match(/v\.douyin\.com\/(\w+)/);
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
    } catch {
      return null;
    }
  }

  return null;
}

async function fetchDouyinComments(awemeId, maxCount) {
  const allComments = [];
  let cursor = 0;
  const limit = Math.min(maxCount, 500);

  while (allComments.length < limit) {
    try {
      const url = `https://www.douyin.com/aweme/v1/web/comment/list/?` +
        new URLSearchParams({
          aweme_id: awemeId,
          cursor: String(cursor),
          count: '50',
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
        },
      });

      if (!resp.ok) {
        if (resp.status === 403) {
          break;
        }
        break;
      }

      const data = await resp.json();

      if (!data || !data.comments || data.comments.length === 0) {
        break;
      }

      for (const c of data.comments) {
        allComments.push({
          text: c.text || '',
          user: c.user?.nickname || '匿名',
          diggCount: c.digg_count || 0,
          createTime: c.create_time || 0,
          replyCount: c.reply_comment_total || 0,
        });
      }

      if (!data.has_more) {
        break;
      }
      cursor = data.cursor || cursor + 50;
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

识别规则：
1. 明显的生日日期：如 "12月25日"、"1月1日" 等
2. 生日祝福：如 "生日快乐"、"祝你生日快乐"、"生快" 等
3. 出生日期表达：如 "我是X月X日生的"、"我的生日是X月X日"
4. 星座相关：如 "天蝎座"、"处女座" 等（同时输出日期范围）
5. 日期格式：可能包含"农历"、"阴历"等前缀

对于每条匹配的评论，提取：
- "commentIndex": 评论序号（数字）
- "date": 提取到的日期（如 "12月25日"，无明确日期则用星座代替）
- "type": 类型（"birthday"=明确生日, "zodiac"=星座, "wish"=生日祝福）
- "originalText": 评论原文

请严格以 JSON 数组格式返回，不要包含其他内容：
[
  { "commentIndex": 1, "date": "12月25日", "type": "birthday", "originalText": "我生日是12月25日" }
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
          { role: 'system', content: '你是一个精确的日期识别助手，只返回JSON格式数据。' },
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

    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('DeepSeek 调用失败:', err);
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
