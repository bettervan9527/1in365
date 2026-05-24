const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: '仅支持 POST 请求' });
  }

  const { videoUrl, maxComments = 50, debug = false } = req.body || {};

  if (!videoUrl) {
    return res.status(400).json({ error: '请提供抖音视频链接' });
  }

  try {
    const awemeId = await extractAwemeId(videoUrl);
    if (!awemeId) {
      return res.status(400).json({ error: '无法解析视频链接，请检查链接是否正确' });
    }

    const result = await fetchCommentsWithFullMeta(awemeId, maxComments, debug);

    return res.status(200).json({
      success: true,
      videoId: awemeId,
      totalComments: result.comments.length,
      hasMore: result.hasMore,
      source: result.source,
      comments: result.comments,
      rawSample: debug ? result.rawSample : undefined,
      errors: result.errors.length > 0 ? result.errors : undefined,
    });
  } catch (err) {
    console.error('预览失败:', err);
    return res.status(500).json({ error: '预览失败: ' + (err.message || '未知错误') });
  }
}

async function fetchCommentsWithFullMeta(awemeId, maxCount, debug) {
  const sources = [
    { name: 'api_v1', fn: () => tryApiV1(awemeId, maxCount, debug) },
    { name: 'api_v2', fn: () => tryApiV2(awemeId, maxCount, debug) },
    { name: 'page_scrape', fn: () => tryScrapePage(awemeId, maxCount) },
  ];

  const errors = [];

  for (const src of sources) {
    try {
      const r = await src.fn();
      if (r.comments.length > 0) {
        return { ...r, source: src.name, errors };
      }
      if (r.error) errors.push({ source: src.name, error: r.error });
    } catch (e) {
      errors.push({ source: src.name, error: e.message });
    }
  }

  return { comments: [], hasMore: false, source: 'none', errors };
}

async function tryApiV1(awemeId, maxCount, debug) {
  const allComments = [];
  let cursor = 0;
  const limit = Math.min(maxCount, 100);
  let rawSample = null;

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
        },
      });

      if (!resp.ok) {
        const statusText = await resp.text().catch(() => '');
        return { comments: allComments, hasMore: false, error: `HTTP ${resp.status}: ${statusText.substring(0, 200)}`, rawSample };
      }

      const data = await resp.json();

      if (!rawSample && debug) {
        rawSample = JSON.stringify(data).substring(0, 2000);
      }

      const commentList = data?.comments || data?.data?.comments || [];
      if (commentList.length === 0) break;

      for (const c of commentList) {
        allComments.push(formatComment(c));
      }

      if (!data.has_more && !data.hasMore) break;
      cursor = data.cursor || cursor + 20;
    } catch (e) {
      return { comments: allComments, hasMore: false, error: e.message, rawSample };
    }
  }

  return { comments: allComments, hasMore: allComments.length >= limit, rawSample };
}

async function tryApiV2(awemeId, maxCount, debug) {
  const allComments = [];
  let cursor = 0;
  const limit = Math.min(maxCount, 100);
  let rawSample = null;

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
