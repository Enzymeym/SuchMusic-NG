/*!
 * @name 聆澜音源-极速版(赞助版)
 * @description 澜音插件 支持所有主流平台全音质
 * @version v2
 * @author 时迁酱&guoyue2010
 * @homepage https://source.shiqianjiang.cn
 */

/**
 * 插件信息
 * @type {Object}
 */
const pluginInfo = {
  name: "聆澜音源-极速版(赞助版)",
  version: "v2",
  author: "时迁酱&guoyue2010",
  description: "澜音插件 支持所有主流平台全音质",
  updateMd5: "644d2b3f7d41abb24d4688e445819b10",
  type: 'such'
};

/**
 * 支持的音源配置
 * @type {Object}
 */
const sources = {
  kw: { name: "酷我音乐", qualitys: ["128k", "320k", "flac", "flac24bit", "hires"] },
  mg: { name: "咪咕音乐", qualitys: ["128k", "320k", "flac", "flac24bit", "hires"] },
  kg: { name: "酷狗音乐", qualitys: ["128k", "320k", "flac", "flac24bit", "hires", "atmos", "master"] },
  tx: { name: "QQ音乐", qualitys: ["128k", "320k", "flac", "flac24bit", "hires", "atmos", "atmos_plus", "master"] },
  wy: { name: "网易云音乐", qualitys: ["128k", "320k", "flac", "flac24bit", "hires", "atmos", "master"] }
};

/**
 * API 地址
 * @type {string}
 */
const apiUrl = "https://source.shiqianjiang.cn";

/**
 * 插件配置UI
 * 用于首次启用时配置卡密
 * @type {Array<Object>}
 */
const configUI = [
  {
    id: "api_key",
    name: "API 密钥",
    description: "请输入您的卡密（API Key），用于验证身份和获取音乐链接",
    type: "password",
    defaultValue: "",
    placeholder: "请输入卡密",
    required: true,
    emit: "onApiKeyChange"
  },
  {
    id: "enable_hires",
    name: "启用 Hi-Res 音质",
    description: "是否优先尝试获取 Hi-Res 无损音质",
    type: "switch",
    defaultValue: true
  },
  {
    id: "timeout",
    name: "请求超时时间",
    description: "请求音乐链接的超时时间（秒）",
    type: "number",
    defaultValue: 15,
    validation: {
      min: 5,
      max: 60
    }
  }
];

/**
 * 插件名格式化修饰
 * @param {string} source - 音源ID
 * @returns {string} 格式化后的插件名
 */
function pluginName(source) {
  return `[${pluginInfo.name} <${sources[source].name}>]`;
}

/**
 * 验证卡密是否有效
 * @param {string} apiKey - 卡密
 * @returns {Promise<boolean>} 验证结果
 */
async function validateApiKey(apiKey) {
  if (!apiKey) {
    console.error("API Key 不能为空");
    return false;
  }

  try {
    const result = await suchmusic.request(`${apiUrl}/music/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        'User-Agent': `SuchMusic-Plugin/${pluginInfo.version}`
      },
      body: JSON.stringify({ key: apiKey }),
      timeout: 10000
    });

    if (result.statusCode === 200 && result.body && result.body.code === 200) {
      console.log("API Key 验证成功");
      return true;
    } else {
      console.error("API Key 验证失败:", result.body?.message || "未知错误");
      return false;
    }
  } catch (error) {
    console.error("API Key 验证出错:", error.message);
    // 如果验证接口不可用，允许使用（降级处理）
    return true;
  }
}

/**
 * 卡密变更回调
 * 当用户在配置界面修改卡密时触发
 * @param {string} apiKey - 新的卡密
 */
async function onApiKeyChange(apiKey) {
  if (!apiKey) {
    suchmusic.NoticeCenter('error', {
      title: '配置错误',
      content: 'API 密钥不能为空'
    });
    return;
  }

  console.log("正在验证 API Key...");

  // 保存配置
  await suchmusic.setPluginConfig('linglan', 'api_key', apiKey);

  // 验证卡密
  const isValid = await validateApiKey(apiKey);

  if (isValid) {
    suchmusic.NoticeCenter('success', {
      title: '配置成功',
      content: 'API 密钥已保存并验证通过'
    });
  } else {
    suchmusic.NoticeCenter('warning', {
      title: '配置警告',
      content: 'API 密钥验证失败，请检查卡密是否正确'
    });
  }
}

/**
 * 获取音乐链接的主要方法
 * @param {string} source - 音源ID
 * @param {Object} musicInfo - 音乐信息
 * @param {string} quality - 音质
 * @returns {Promise<string>} 音乐链接
 */
async function musicUrl(source, musicInfo, quality) {
  console.log("收到解析请求", '-------------不优雅的分割线-------------');

  try {
    // 检查source是否有效
    if (!sources[source]) {
      throw new Error(`无效的音源: ${source}`);
    }

    // 检查quality是否有效
    if (!sources[source].qualitys.includes(quality)) {
      throw new Error(`无效的音质: ${quality}，支持的音质: ${sources[source].qualitys.join(', ')}`);
    }

    const songId = musicInfo.hash ?? musicInfo.songmid ?? musicInfo.id;

    if (!songId) {
      throw new Error('音乐ID不存在');
    }

    // 获取配置
    const apiKey = await suchmusic.getPluginConfig('linglan', 'api_key');
    const timeout = await suchmusic.getPluginConfig('linglan', 'timeout') || 15;

    if (!apiKey) {
      suchmusic.NoticeCenter('error', {
        title: '配置错误',
        content: '请先配置 API 密钥（卡密）'
      });
      throw new Error('未配置 API 密钥');
    }

    console.log(`${pluginName(source)} 请求音乐链接: 歌曲ID: ${songId}, 音质: ${quality}`);

    // 使用 suchmusic API 发送 HTTP 请求
    const result = await suchmusic.request(`${apiUrl}/music/url?source=${source}&songId=${songId}&quality=${quality}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        'User-Agent': `SuchMusic-Plugin/${pluginInfo.version}`
      },
      timeout: timeout * 1000
    });

    console.info(`${pluginName(source)} 请求响应数据:`, result.body);
    console.log(`${pluginName(source)} 请求结束，响应状态码: ${result.statusCode}`);

    if (result.statusCode === 200 && result.body && result.body.code === 200) {
      if (result.body.url) {
        console.log(`${pluginName(source)} 获取音乐链接成功: ${songId}, 音质: ${quality}, 链接: ${result.body.url}`);
        return result.body.url;
      } else {
        throw new Error('返回数据中没有音乐链接');
      }
    } else if (result.body && result.body.code) {
      switch (result.body.code) {
        case 403:
          suchmusic.NoticeCenter('error', {
            title: '音乐链接获取失败',
            content: `来源: ${pluginName(source)}, 错误: API Key失效或鉴权失败，请检查卡密`
          });
          throw new Error('API Key失效或鉴权失败');
        case 429:
          suchmusic.NoticeCenter('error', {
            title: '音乐链接获取失败',
            content: `来源: ${pluginName(source)}, 错误: 请求过于频繁，请稍后再试`
          });
          throw new Error('请求过于频繁，请稍后再试');
        case 500:
          throw new Error(`服务器错误: ${result.body.message || '未知错误'}`);
        default:
          suchmusic.NoticeCenter('error', {
            title: '音乐链接获取失败',
            content: `来源: ${pluginName(source)}, 错误: API错误 ${result.body.message || '未知错误'}`
          });
          throw new Error(`API错误: ${result.body.message || '未知错误'}`);
      }
    } else {
      throw new Error(`HTTP请求失败: ${result.statusCode}`);
    }
  } catch (error) {
    console.error(`${pluginName(source)} 获取音乐链接失败:`, error.message);
    throw new Error(error.message || error);
  }
}

/**
 * 获取歌曲封面
 * @param {string} source - 音源ID
 * @param {Object} musicInfo - 音乐信息
 * @returns {Promise<string>} 封面图片URL
 */
async function getPic(source, musicInfo) {
  try {
    const songId = musicInfo.hash ?? musicInfo.songmid ?? musicInfo.id;
    if (!songId) {
      return '';
    }

    const apiKey = await suchmusic.getPluginConfig('linglan', 'api_key');

    const result = await suchmusic.request(`${apiUrl}/music/pic?source=${source}&songId=${songId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey || '',
        'User-Agent': `SuchMusic-Plugin/${pluginInfo.version}`
      },
      timeout: 10000
    });

    if (result.statusCode === 200 && result.body && result.body.code === 200) {
      return result.body.pic || '';
    }
    return '';
  } catch (error) {
    console.error(`${pluginName(source)} 获取封面失败:`, error.message);
    return '';
  }
}

/**
 * 获取歌词
 * @param {string} source - 音源ID
 * @param {Object} musicInfo - 音乐信息
 * @returns {Promise<string>} LRC歌词
 */
async function getLyric(source, musicInfo) {
  try {
    const songId = musicInfo.hash ?? musicInfo.songmid ?? musicInfo.id;
    if (!songId) {
      return '';
    }

    const apiKey = await suchmusic.getPluginConfig('linglan', 'api_key');

    const result = await suchmusic.request(`${apiUrl}/music/lyric?source=${source}&songId=${songId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey || '',
        'User-Agent': `SuchMusic-Plugin/${pluginInfo.version}`
      },
      timeout: 10000
    });

    if (result.statusCode === 200 && result.body && result.body.code === 200) {
      return result.body.lyric || '';
    }
    return '';
  } catch (error) {
    console.error(`${pluginName(source)} 获取歌词失败:`, error.message);
    return '';
  }
}

/**
 * 检查更新
 */
const checkUpdate = async () => {
  try {
    const apiKey = await suchmusic.getPluginConfig('linglan', 'api_key');

    const { body } = await suchmusic.request(
      `${apiUrl}/script?checkUpdate=${pluginInfo.updateMd5}&key=${apiKey || ''}&type=${pluginInfo.type}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": `SuchMusic-Plugin/${pluginInfo.version}`
        },
      }
    );

    console.log('版本更新检测响应:', body);

    if (!body || body.code !== 200) {
      console.error('版本更新检测失败:', body.message || '未知错误');
    } else {
      if (body.data != null) {
        suchmusic.NoticeCenter('update', {
          title: `${pluginInfo.name} 有新的版本 ${body.data.version}`,
          content: body.data.updateMsg,
          url: `${body.data.updateUrl}`,
          version: body.data.version,
          pluginInfo: {
            name: pluginInfo.name,
            type: 'such'
          }
        });
      } else {
        console.log(`${pluginInfo.name} 没有新的版本`);
      }
    }
  } catch (error) {
    console.error("checkUpdate error:", error);
  }
};

// 插件加载时检查更新
setTimeout(() => {
  checkUpdate().then(() => {
    console.log("版本更新检测完成");
  });
}, 5000);

/**
 * 导出插件
 * @exports
 */
module.exports = {
  pluginInfo,
  sources,
  configUI,
  musicUrl,
  getPic,
  getLyric,
  onApiKeyChange
};
