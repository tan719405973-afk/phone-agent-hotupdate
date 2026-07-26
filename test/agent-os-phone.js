/* ====================================================================
    Agent OS Phone — 手机端完整 Agent 运行时
    架构：20 模块成熟 Agent 清单（Core / Memory / Tool / Planner / Executor
          / Workflow / Reflection / State / Task / Log / Config / Safety…）
    依赖：NativeBridge（文件操作）、fetchTimeout（API 调用）
    集成：phone-agent 加载后 window.AgentOS 全局对象，doChat 拦截调用
   ==================================================================== */
(function(){

'use strict';

/* ======================= 1. 配置中心 ======================= */
var CONFIG = {
  // 模型
  model: "agnes",           // 当前模型标识
  modelConfig: {
    agnes: { apiKey: "", baseUrl: "", model: "agnes-2.0-flash" }
  },
  // 工作区
  workspace: "phone-agent-workspace",
  // 安全
  safety: {
    maxFileSize: 10 * 1024 * 1024,       // 10MB
    allowedExts: [],                      // 空=允许所有
    blockedExts: [".exe",".dll",".bat",".cmd",".ps1",".vbs",".jar",".apk"],
    confirmDanger: true,                  // 危险操作需确认
    dangerPatterns: [/rm\s+-rf/i, /format\s+\w/i, /del\s+\/f/i]
  },
  // 日志
  logLevel: "info",         // debug / info / warn / error
  maxLogEntries: 200,
  // 对话
  maxHistoryTokens: 8000,
  maxToolRetries: 2,
  // 成本
  costLimit: { dailyTokens: 0, monthlyCost: 0 },  // 0 = 不限
  // 规则（宪法）
  constitution: {
    agentId: "agent-os-phone-" + Date.now(),
    agentName: "智能助手",
    intent: "长期可靠地在手机上帮助用户完成工作",
    standingConstraints: [
      "用中文回复",
      "尊重用户隐私，不泄漏个人信息",
      "重要操作（删除/格式化/覆盖文件）前必须向用户确认"
    ],
    redLines: [
      "rm -rf", "format", "del /f", "shutdown", "reboot",
      "修改系统文件", "读取隐私文件（如相册/通讯录）除非用户明确要求"
    ],
    userPreferences: {}       // 从学习系统动态更新
  }
};

/* ======================= 2. 日志系统 ======================= */
var Logger = {
  _entries: [],
  _max: CONFIG.maxLogEntries,
  _onNew: null,  // 回调：新日志通知 UI
  _level: { debug:0, info:1, warn:2, error:3 },

  debug: function(msg, data){ this._log("debug", msg, data); },
  info: function(msg, data){ this._log("info", msg, data); },
  warn: function(msg, data){ this._log("warn", msg, data); },
  error: function(msg, data){ this._log("error", msg, data); },

  _log: function(level, msg, data){
    if(this._level[level] < this._level[CONFIG.logLevel]) return;
    var entry = { ts: Date.now(), level: level, msg: msg, data: data };
    this._entries.unshift(entry);
    if(this._entries.length > this._max) this._entries.pop();
    if(this._onNew) this._onNew(entry);
  },
  getLogs: function(level){ return level ? this._entries.filter(function(e){ return e.level===level; }) : this._entries; },
  clear: function(){ this._entries = []; },
  setCallback: function(fn){ this._onNew = fn; }
};

/* ======================= 3. 模型适配器 ======================= */
var ModelAdapter = {
  /* 使用 phone-agent 现有的 API 配置 */
  chat: function(messages, opts){
    opts = opts || {};
    return new Promise(function(resolve, reject){
      var apiKey = typeof currentApiKey === 'function' ? currentApiKey() : "";
      var apiBase = typeof apiBase === 'function' ? apiBase() : "";
      var model = opts.model || (typeof currentModel === 'function' ? currentModel("text") : "agnes-2.0-flash");
      if(!apiKey){ reject(new Error("API Key 未配置")); return; }
      var body = { model: model, messages: messages, stream: false };
      if(opts.tools) body.tools = opts.tools;
      if(opts.tool_choice) body.tool_choice = opts.tool_choice;
      if(opts.max_tokens) body.max_tokens = opts.max_tokens;
      if(opts.temperature != null) body.temperature = opts.temperature;
      var fetchFn = typeof fetchTimeout === 'function' ? fetchTimeout : (typeof nativeFetch === 'function' ? nativeFetch : fetch);
      fetchFn(apiBase + "/chat/completions", {
        method: "POST",
        timeout: opts.timeout || 120000,
        headers: { "Content-Type":"application/json", "Authorization":"Bearer " + apiKey },
        body: JSON.stringify(body)
      }).then(function(r){
        if(!r.ok) return r.text().then(function(t){ throw new Error("HTTP " + r.status + " " + t.slice(0,200)); });
        return r.json();
      }).then(function(j){
        var choice = j.choices && j.choices[0];
        if(!choice){ reject(new Error("API 返回异常")); return; }
        resolve({
          message: choice.message || { role:"assistant", content:"" },
          finish_reason: choice.finish_reason || "stop",
          usage: j.usage || { prompt_tokens:0, completion_tokens:0 }
        });
      }).catch(function(err){ reject(err); });
    });
  }
};

/* ======================= 4. 记忆系统 ======================= */
var Memory = {
  _session: { entries: [] },
  _project: null,
  _user: null,
  _scratchpad: {},
  _loaded: false,

  /* 从 NativeBridge / localStorage 加载持久化记忆 */
  load: function(){
    if(this._loaded) return;
    try{
      var raw = typeof nLoad === 'function' ? nLoad("agent_memory") : localStorage.getItem("pa_agent_memory");
      if(raw){
        var d = JSON.parse(raw);
        this._project = d.project || null;
        this._user = d.user || null;
        this._scratchpad = d.scratchpad || {};
        this._loaded = true;
      }
    }catch(e){ Logger.warn("记忆加载失败", e); }
    if(!this._project) this._project = { convs:{}, facts:[] };
    if(!this._user) this._user = { profile:"", preferences:{}, history:[] };
    this._loaded = true;
  },
  save: function(){
    try{
      var data = JSON.stringify({ project: this._project, user: this._user, scratchpad: this._scratchpad });
      if(typeof nSave === 'function') nSave("agent_memory", data);
      else localStorage.setItem("pa_agent_memory", data);
    }catch(e){ Logger.error("记忆保存失败", e); }
  },

  /* 会话记忆 */
  sessionPush: function(role, content){
    this._session.entries.push({ role: role, content: content, ts: Date.now() });
    if(this._session.entries.length > 100) this._session.entries.splice(0, 20);
  },
  sessionGet: function(n){
    return this._session.entries.slice(-(n||50));
  },
  sessionClear: function(){
    // 保留最后 2 轮以便上下文连贯
    this._session.entries = this._session.entries.slice(-4);
  },

  /* 用户记忆 */
  getUserProfile: function(){ return this._user; },
  updateUserProfile: function(profile){
    this._user.profile = profile;
    this.save();
  },
  learnFact: function(fact){
    if(!fact || fact.length < 5) return;
    this._user.history.push({ text: fact, ts: Date.now() });
    if(this._user.history.length > 100) this._user.history = this._user.history.slice(-100);
    this.save();
  },

  /* 项目记忆 */
  updateConvSummary: function(convId, summary){
    this._project.convs[convId] = { summary: summary, ts: Date.now() };
    this.save();
  },

  /* 草稿本（中间结果、临时缓存） */
  scratchSet: function(key, val){ this._scratchpad[key] = val; },
  scratchGet: function(key){ return this._scratchpad[key]; },
  scratchClear: function(key){ if(key) delete this._scratchpad[key]; else this._scratchpad = {}; },

  /* 构建记忆上下文 */
  buildContext: function(input){
    this.load();
    var parts = [];
    if(this._user.profile) parts.push("【用户画像】\n" + this._user.profile);
    if(this._user.history.length){
      var recent = this._user.history.slice(-5);
      parts.push("【历史经验】\n" + recent.map(function(f){ return "- " + f.text; }).join("\n"));
    }
    var convKeys = Object.keys(this._project.convs || {}).slice(-3);
    if(convKeys.length){
      parts.push("【最近项目/对话要点】\n" + convKeys.map(function(k){
        return "- " + (this._project.convs[k] ? this._project.convs[k].summary : "");
      }, this).join("\n"));
    }
    return parts.join("\n\n");
  }
};

/* ======================= 5. 安全系统 ======================= */
var Safety = {
  /* 检查文件操作是否允许 */
  checkFileOp: function(op, path, content){
    var cfg = CONFIG.safety;
    // 禁止操作系统敏感路径
    var blockedPaths = [/^\/system\b/i, /^C:\\Windows\b/i, /^C:\\Program Files\b/i, /\/proc\b/, /\/sys\b/];
    for(var i=0; i<blockedPaths.length; i++){
      if(blockedPaths[i].test(path)) return { allowed: false, reason: "禁止操作系统文件" };
    }
    // 检查扩展名
    var ext = path.lastIndexOf(".") >= 0 ? path.slice(path.lastIndexOf(".")).toLowerCase() : "";
    if(cfg.blockedExts.indexOf(ext) >= 0) return { allowed: false, reason: "禁止操作 " + ext + " 文件" };
    return { allowed: true };
  },

  /* 检查是否有危险模式 */
  isDangerAction: function(action, params){
    var d = CONFIG.safety.dangerPatterns;
    var text = action + " " + JSON.stringify(params);
    for(var i=0; i<d.length; i++){
      if(d[i].test(text)) return true;
    }
    return false;
  },

  /* 需要用户确认的危险操作 */
  confirmAction: function(action, description){
    return new Promise(function(resolve){
      if(typeof showConfirm === 'function'){
        showConfirm("⚠️ " + action, description + "\n\n确定执行吗？", function(yes){ resolve(yes); });
      } else {
        resolve(confirm(action + "\n" + description));
      }
    });
  },

  /* 检查宪法红线 */
  checkConstitution: function(text){
    var redLines = CONFIG.constitution.redLines;
    for(var i=0; i<redLines.length; i++){
      if(text.indexOf(redLines[i]) >= 0) return { violated: true, rule: redLines[i] };
    }
    return { violated: false };
  }
};

/* ======================= 6. 工具系统 ======================= */
var ToolRegistry = {};

var Tools = {
  registry: {},

  register: function(name, manifest){
    this.registry[name] = manifest;
    Logger.info("工具注册: " + name);
  },

  get: function(name){ return this.registry[name]; },

  list: function(){ return Object.keys(this.registry).map(function(k){ return { name:k, desc:this.registry[k].description }; }, this); },

  /* 工具定义（OpenAI function calling 格式） */
  getDefinitions: function(){
    return Object.keys(this.registry).map(function(k){
      var t = this.registry[k];
      return {
        type: "function",
        function: {
          name: k,
          description: t.description,
          parameters: t.parameters || {}
        }
      };
    }, this);
  },

  /* 执行工具 */
  execute: function(name, args, context){
    var t = this.registry[name];
    if(!t) return Promise.reject(new Error("未知工具: " + name));
    // 安全检查
    if(t.safetyCheck && t.safetyCheck(args)){
      var chk = t.safetyCheck(args);
      if(!chk.allowed) return Promise.resolve({ error: chk.reason, ok: false });
    }
    Logger.info("工具调用: " + name, args);
    context && context.onToolStart && context.onToolStart(name, args);
    return Promise.resolve().then(function(){ return t.handler(args, context); }).then(function(result){
      Logger.info("工具完成: " + name, result);
      context && context.onToolEnd && context.onToolEnd(name, result);
      return result;
    }).catch(function(err){
      Logger.error("工具失败: " + name, err);
      context && context.onToolError && context.onToolError(name, err);
      return { error: err.message || String(err), ok: false };
    });
  }
};

/* ---- 文件工具 ---- */
Tools.register("read_file", {
  description: "读取工作区内的文件内容。支持 txt / md / json / js / html / css / py 等文本格式。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对于工作区的文件路径，如 project/notes.md" }
    },
    required: ["path"]
  },
  handler: function(args, ctx){
    var path = args.path;
    if(!path) return { error: "缺少 path 参数" };
    var check = CONFIG.safety.allowedExts.length;
    if(check){
      var ext = path.lastIndexOf(".") >= 0 ? path.slice(path.lastIndexOf(".")).toLowerCase() : "";
      if(Safety.checkFileOp("read", path).allowed === false) return { error: "不允许读取该文件" };
    }
    return phoneFileRead(path);
  },
  safetyCheck: function(args){ return Safety.checkFileOp("read", args.path); }
});

Tools.register("write_file", {
  description: "写入内容到工作区内的文件。文件不存在则创建，存在则覆盖。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对于工作区的文件路径" },
      content: { type: "string", description: "文件内容" }
    },
    required: ["path", "content"]
  },
  handler: function(args){
    if(!args.path || args.content == null) return { error: "缺少参数" };
    var chk = Safety.checkFileOp("write", args.path);
    if(!chk.allowed) return { error: chk.reason };
    return phoneFileWrite(args.path, args.content);
  },
  safetyCheck: function(args){ return Safety.checkFileOp("write", args.path); }
});

Tools.register("append_file", {
  description: "追加内容到工作区内的文件末尾。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对于工作区的文件路径" },
      content: { type: "string", description: "要追加的内容" }
    },
    required: ["path", "content"]
  },
  handler: function(args){
    return phoneFileAppend(args.path, args.content);
  }
});

Tools.register("list_directory", {
  description: "列出工作区目录下的文件和文件夹。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目录路径，空=工作区根目录" }
    },
    required: []
  },
  handler: function(args){
    return phoneFileList(args.path || "");
  }
});

Tools.register("delete_file", {
  description: "删除工作区内的文件（需确认）。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对于工作区的文件路径" }
    },
    required: ["path"]
  },
  handler: function(args){
    return Safety.confirmAction("删除文件", "确定删除 " + args.path + " 吗？").then(function(ok){
      if(!ok) return { ok: false, error: "用户取消" };
      return phoneFileDelete(args.path);
    });
  }
});

/* ---- 网络工具 ---- */
Tools.register("web_fetch", {
  description: "抓取指定 URL 的网页内容。",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "完整 URL" }
    },
    required: ["url"]
  },
  handler: function(args){
    if(!args.url) return { error: "缺少 URL" };
    var fetchFn = typeof nativeFetch === 'function' ? nativeFetch : fetch;
    return fetchFn(args.url, { timeout: 30000 }).then(function(r){
      if(!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }).then(function(body){
      return { ok: true, content: body.slice(0, 50000) };
    });
  }
});

Tools.register("web_search", {
  description: "在百度搜索关键词，返回搜索结果摘要。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词" }
    },
    required: ["query"]
  },
  handler: function(args){
    if(!args.query) return { error: "缺少搜索词" };
    // 使用原生 HTTP 请求绕过 CORS
    var q = encodeURIComponent(args.query);
    var url = "https://www.baidu.com/s?wd=" + q;
    return phoneFileFetch(url).then(function(body){
      var results = [];
      var re = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/g;
      var m;
      while((m = re.exec(body)) !== null && results.length < 8){
        results.push({ title: m[2].replace(/<[^>]+>/g,"").trim(), url: m[1] });
      }
      return { ok: true, results: results, count: results.length };
    }).catch(function(err){
      return { ok: false, error: "搜索失败: " + (err.message||"") };
    });
  }
});

/* ---- AI 工具（调用其他 AI 模型） ---- */
Tools.register("translate", {
  description: "翻译文本到目标语言。",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "要翻译的文本" },
      target: { type: "string", description: "目标语言，如 '英语'、'日语'", default: "中文" }
    },
    required: ["text"]
  },
  handler: function(args){
    return ModelAdapter.chat([
      { role:"system", content:"你是一个翻译助手。只输出译文，不要解释。" },
      { role:"user", content:"把以下文本翻译成" + (args.target||"中文") + "：\n" + args.text }
    ], { max_tokens: 2000, temperature: 0.3 }).then(function(r){
      return { ok: true, result: r.message.content };
    });
  }
});

/* ---- 手机原生文件操作桥接 ---- */
/* 这些函数使用 NativeBridge 或备用方案 */
function phoneFileRead(path){
  return new Promise(function(resolve, reject){
    if(typeof NativeBridge !== "undefined" && NativeBridge.readFile){
      var r = NativeBridge.readFile(path);
      if(r && r.indexOf("err:")!==0) resolve({ ok:true, content: r });
      else reject(new Error(r || "读取失败"));
    } else if(typeof nLoad === 'function'){
      var r = nLoad("workspace/" + path);
      resolve({ ok:true, content: r || "" });
    } else {
      reject(new Error("文件读取不可用"));
    }
  });
}
function phoneFileWrite(path, content){
  return new Promise(function(resolve, reject){
    if(typeof NativeBridge !== "undefined" && NativeBridge.writeFile){
      var r = NativeBridge.writeFile(path, content);
      if(r === "ok" || !r) resolve({ ok:true });
      else reject(new Error(r));
    } else if(typeof nSave === 'function'){
      nSave("workspace/" + path, content);
      resolve({ ok:true });
    } else {
      reject(new Error("文件写入不可用"));
    }
  });
}
function phoneFileAppend(path, content){
  /* 先读再写（简陋版，后续可加原生 append） */
  return phoneFileRead(path).then(function(existing){
    var newContent = (existing.ok ? existing.content : "") + "\n" + content;
    return phoneFileWrite(path, newContent);
  });
}
function phoneFileList(dir){
  return new Promise(function(resolve, reject){
    if(typeof NativeBridge !== "undefined" && NativeBridge.listDir){
      var r = NativeBridge.listDir(dir);
      resolve({ ok:true, files: r || [] });
    } else {
      resolve({ ok:true, files: [], note: "列目录不可用" });
    }
  });
}
function phoneFileDelete(path){
  return new Promise(function(resolve, reject){
    if(typeof NativeBridge !== "undefined" && NativeBridge.deleteFile){
      var r = NativeBridge.deleteFile(path);
      if(r === "ok" || !r) resolve({ ok:true });
      else reject(new Error(r));
    } else {
      reject(new Error("删除不可用"));
    }
  });
}
function phoneFileFetch(url){
  return new Promise(function(resolve, reject){
    if(typeof nativeFetch === 'function'){
      nativeFetch(url, { timeout: 30000 }).then(function(r){
        if(!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      }).then(resolve).catch(reject);
    } else {
      fetch(url, { signal: AbortSignal.timeout(30000) }).then(function(r){
        if(!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      }).then(resolve).catch(reject);
    }
  });
}

/* ======================= 7. 状态管理 ======================= */
var State = {
  _states: {
    IDLE: "空闲", PLANNING: "规划中", EXECUTING: "执行中",
    WAITING: "等待用户", CHECKING: "检查中", REFLECTING: "反思中",
    DONE: "完成", FAILED: "失败", CANCELLED: "已取消"
  },
  _current: "IDLE",
  _history: [],
  _listeners: [],

  get: function(){ return this._current; },
  getName: function(){ return this._states[this._current] || this._current; },

  set: function(s){
    var from = this._current;
    this._current = s;
    this._history.push({ from: from, to: s, ts: Date.now() });
    Logger.info("状态: " + this._states[from] + " → " + (this._states[s]||s));
    this._listeners.forEach(function(fn){ fn(s, from); });
  },

  onChange: function(fn){ this._listeners.push(fn); },

  can: function(s){ /* 仅用于扩展 */ return true; },

  reset: function(){ this._current = "IDLE"; }
};

/* ======================= 8. 任务管理 ======================= */
var TaskManager = {
  _tasks: {},
  _seq: 0,

  create: function(desc, parentId){
    this._seq++;
    var task = {
      id: "t" + this._seq,
      desc: desc,
      status: "pending",  // pending / running / done / failed / cancelled
      parentId: parentId || null,
      subTasks: [],
      priority: 0,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
      logs: []
    };
    this._tasks[task.id] = task;
    if(parentId && this._tasks[parentId]) this._tasks[parentId].subTasks.push(task.id);
    return task;
  },

  get: function(id){ return this._tasks[id]; },

  update: function(id, updates){
    var t = this._tasks[id];
    if(!t) return;
    for(var k in updates) t[k] = updates[k];
    if(updates.status === "running" && !t.startedAt) t.startedAt = Date.now();
    if(updates.status === "done" || updates.status === "failed") t.finishedAt = Date.now();
  },

  getPending: function(){ return Object.keys(this._tasks).filter(function(k){ return this._tasks[k].status === "pending"; }, this); },

  getActive: function(){ return Object.keys(this._tasks).filter(function(k){ return this._tasks[k].status === "running"; }, this); }
};

/* ======================= 9. 规划器 ======================= */
var Planner = {
  /* 分析用户输入，生成执行计划 */
  plan: function(userInput, context){
    Logger.info("规划器: 分析任务", userInput.slice(0,100));
    State.set("PLANNING");
    var conv = context.conversation;
    var memCtx = Memory.buildContext(userInput);
    var sysPrompt = [
      CONFIG.constitution.intent,
      "你是 " + CONFIG.constitution.agentName + "，一个在手机上运行的智能助手。",
      "你的核心原则：",
      CONFIG.constitution.standingConstraints.join("\n"),
      "",
      "【可用的工具】",
      Object.keys(Tools.registry).map(function(k){
        return "- " + k + "：" + Tools.registry[k].description;
      }).join("\n"),
      "",
      memCtx ? "【用户背景记忆】\n" + memCtx : "",
      "",
      "【响应格式】",
      "不要直接回答用户。先分析用户的目标，然后返回 JSON 格式的执行计划：",
      '{"goal":"用户目标的简短描述","steps":[{"tool":"工具名","args":{"参数名":"值"},"desc":"这一步要做什么的说明"}],"needInfo":["如果需要用户补充信息就在这里列出"]}',
      "如果不需要任何工具，直接回答用户，则返回：",
      '{"directReply":"你的回复内容"}',
      "如果不能解析用户意图，返回：",
      '{"needInfo":["你的疑问列表"]}'
    ].join("\n");

    return ModelAdapter.chat([
      { role:"system", content: sysPrompt },
      { role:"user", content: userInput }
    ], { temperature: 0.3, max_tokens: 2000 }).then(function(r){
      var text = r.message.content || "";
      Logger.debug("规划器响应", text.slice(0,200));
      try {
        // 尝试解析 JSON
        var jsonStart = text.indexOf("{");
        var jsonEnd = text.lastIndexOf("}");
        if(jsonStart >= 0 && jsonEnd > jsonStart){
          var plan = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
          if(plan.directReply) return { type: "direct", reply: plan.directReply };
          if(plan.goal && plan.steps) return { type: "plan", goal: plan.goal, steps: plan.steps, needInfo: plan.needInfo };
          if(plan.needInfo) return { type: "ask", questions: plan.needInfo };
        }
      } catch(e){ Logger.warn("规划器解析失败", e); }
      // 解析失败，当 direct 处理
      return { type: "direct", reply: text };
    });
  }
};

/* ======================= 10. 执行器 ======================= */
var Executor = {
  executePlan: function(plan, context){
    State.set("EXECUTING");
    var results = [];
    var stepIdx = 0;

    function nextStep(){
      if(stepIdx >= plan.steps.length){ State.set("DONE"); return Promise.resolve(results); }
      var step = plan.steps[stepIdx];
      var taskId = "exec_" + (stepIdx + 1);

      Logger.info("执行步骤 " + (stepIdx+1) + "/" + plan.steps.length + ": " + (step.desc||step.tool));
      context.onProgress && context.onProgress(stepIdx, plan.steps.length, step);

      return Tools.execute(step.tool, step.args || {}, {
        onToolStart: function(name, args){
          context.onToolStart && context.onToolStart(name, args, stepIdx);
        },
        onToolEnd: function(name, result){
          context.onToolEnd && context.onToolEnd(name, result, stepIdx);
        }
      }).then(function(result){
        results.push({ step: step, result: result, idx: stepIdx });
        if(result && result.ok === false && CONFIG.maxToolRetries > 0){
          // 失败重试（暂不实现自动重试）
        }
        stepIdx++;
        return nextStep();
      });
    }
    return nextStep();
  }
};

/* ======================= 11. 反思系统 ======================= */
var Reflection = {
  reflect: function(userInput, planResult, execResults, context){
    State.set("REFLECTING");
    var execSummary = execResults.map(function(r, i){
      return "步骤" + (i+1) + "(" + r.step.tool + "): " + (r.result.ok !== false ? "成功" : "失败: " + (r.result.error||""));
    }).join("\n");

    // 如果所有步骤都成功了，不需要反思
    var allOk = execResults.every(function(r){ return r.result.ok !== false; });
    if(allOk){ State.set("DONE"); return Promise.resolve(null); }

    var prompt = [
      "用户目标：" + userInput,
      "执行计划：",
      planResult.steps.map(function(s,i){ return (i+1)+". "+s.tool+"("+JSON.stringify(s.args)+") - "+s.desc; }).join("\n"),
      "执行结果：",
      execSummary,
      "",
      "部分步骤失败了。请分析失败原因，给出修正后的新计划（同样格式的 JSON）。",
      "如果不需要修正，返回：{\"done\":true}"
    ].join("\n");

    return ModelAdapter.chat([
      { role:"system", content: "你是反思者，分析执行结果、找出失败根因、输出修正方案。输出 JSON。" },
      { role:"user", content: prompt }
    ], { temperature: 0.3 }).then(function(r){
      var text = r.message.content || "";
      try {
        var j = text.indexOf("{"); var k = text.lastIndexOf("}");
        if(j >= 0 && k > j) return JSON.parse(text.slice(j, k+1));
      } catch(e){}
      return { done: true };
    });
  }
};

/* ======================= 12. 上下文管理 ======================= */
var Context = {
  _tokenBudget: 8000,
  _cache: {},

  buildPrompt: function(userInput, memoryCtx, systemRules){
    var parts = [];
    // 系统角色
    parts.push({ role:"system", content: [
      "你是 " + CONFIG.constitution.agentName + "，一个在手机上运行的智能助手。",
      systemRules || CONFIG.constitution.standingConstraints.join("\n"),
      "【能力和限制】",
      "- 你可以读写手机工作区（" + CONFIG.workspace + "）内的文件",
      "- 你可以抓取网页、搜索百度",
      "- 你不能执行 shell 命令",
      "- 重要操作会先向你确认",
      memoryCtx ? "\n" + memoryCtx : ""
    ].filter(Boolean).join("\n") });
    // 会话历史
    var session = Memory.sessionGet(20);
    session.forEach(function(e){
      parts.push({ role: e.role, content: e.content });
    });
    // 当前输入
    parts.push({ role:"user", content: userInput });
    return parts;
  }
};

/* ======================= 13. 学习系统 ======================= */
var Learning = {
  learnFromInteraction: function(userInput, response, plan, results){
    Memory.load();
    // 提取可能值得记住的用户偏好
    var prefPatterns = [
      /我喜欢(\w+)/, /我习惯(\w+)/, /我常用(\w+)/,
      /我住在(\w+)/, /我在(\w+)工作/, /我是(\w+)/
    ];
    for(var i=0; i<prefPatterns.length; i++){
      var m = prefPatterns[i].exec(userInput);
      if(m) Memory.learnFact(m[0]);
    }
  }
};

/* ======================= 14. 主控制循环（Orchestrator） ======================= */
var AgentOS = {
  _running: false,
  _cancelled: false,

  /* 主入口：用户发来消息，Agent 处理并返回结果 */
  run: function(userInput, context){
    var self = this;
    context = context || {};
    Logger.info("Agent OS 开始处理", userInput.slice(0,100));
    this._running = true;
    this._cancelled = false;
    Memory.load();

    // 记录到会话记忆
    Memory.sessionPush("user", userInput);

    State.set("PLANNING");
    context.onStatus && context.onStatus("planning");

    return Planner.plan(userInput, { conversation: true }).then(function(plan){
      if(self._cancelled){ State.set("CANCELLED"); return { cancelled: true }; }

      // 检查安全红线
      var conchk = Safety.checkConstitution(userInput);
      if(conchk.violated){
        context.onSafetyViolation && context.onSafetyViolation(conchk.rule);
        return { ok: false, error: "⚠️ 此操作被安全规则拦截：" + conchk.rule };
      }

      if(plan.type === "direct"){
        // 直接回复
        State.set("DONE");
        context.onReply && context.onReply(plan.reply);
        Memory.sessionPush("assistant", plan.reply);
        Learning.learnFromInteraction(userInput, plan.reply, null, null);
        return { ok: true, reply: plan.reply };
      }

      if(plan.type === "ask"){
        // 需要用户补充信息
        State.set("WAITING");
        context.onAsk && context.onAsk(plan.questions);
        return { ok: true, ask: plan.questions };
      }

      if(plan.type === "plan"){
        // 有执行计划
        context.onPlan && context.onPlan(plan);
        context.onProgress && context.onProgress(0, plan.steps.length, null);

        return Executor.executePlan(plan, context).then(function(results){
          if(self._cancelled){ State.set("CANCELLED"); return { cancelled: true }; }

          State.set("CHECKING");
          context.onStatus && context.onStatus("checking");

          // 反思：检查失败步骤
          return Reflection.reflect(userInput, plan, results, context).then(function(fixPlan){
            if(fixPlan && fixPlan.done !== true && fixPlan.steps){
              // 有修正方案，重新执行
              Logger.info("反思后重新规划", fixPlan);
              context.onReflection && context.onReflection(fixPlan);
              return Executor.executePlan({ steps: fixPlan.steps, goal: plan.goal }, context);
            }
            return results;
          }).then(function(finalResults){
            var allResults = Array.isArray(finalResults) ? finalResults : results;
            // 汇总结果给模型生成最终回复
            var summary = allResults.map(function(r,i){
              var s = r.step ? "步骤" + (i+1) + "(" + r.step.tool + ")" : "步骤" + (i+1);
              var res = r.result ? (r.result.ok !== false ? JSON.stringify(r.result).slice(0,300) : "失败: " + r.result.error) : "";
              return s + " → " + res;
            }).join("\n");

            return ModelAdapter.chat([
              { role:"system", content: "你是" + CONFIG.constitution.agentName + "。根据以下执行结果，给用户一个清晰、友好的总结回复。如果执行成功就说完成了什么，如果部分失败就说明哪里出了问题。" },
              { role:"user", content: "用户说：" + userInput + "\n\n执行结果：\n" + summary + "\n\n请回复用户。" }
            ], { temperature: 0.7 }).then(function(r){
              var reply = r.message.content || "";
              State.set("DONE");
              Memory.sessionPush("assistant", reply);
              Learning.learnFromInteraction(userInput, reply, plan, allResults);
              context.onReply && context.onReply(reply);
              return { ok: true, reply: reply, results: allResults };
            });
          });
        });
      }

      State.set("DONE");
      return { ok: true, reply: "好的，已收到。有什么需要帮忙的吗？" };
    }).catch(function(err){
      State.set("FAILED");
      Logger.error("Agent OS 异常", err);
      context.onError && context.onError(err);
      return { ok: false, error: err.message || String(err) };
    }).then(function(result){
      self._running = false;
      return result;
    });
  },

  cancel: function(){
    this._cancelled = true;
    State.set("CANCELLED");
    Logger.info("Agent OS 已取消");
  },

  isRunning: function(){ return this._running; },

  reset: function(){
    this._running = false;
    this._cancelled = false;
    Memory.sessionClear();
    State.reset();
  },

  /* 获取当前状态摘要 */
  getStatus: function(){
    return {
      state: State.get(),
      stateName: State.getName(),
      running: this._running,
      tasks: Object.keys(TaskManager._tasks).length,
      tools: Tools.list().length,
      memoryEntries: (Memory._user && Memory._user.history ? Memory._user.history.length : 0) + Object.keys(Memory._project.convs || {}).length
    };
  }
};

/* ======================= 暴露全局接口 ======================= */
window.AgentOS = AgentOS;
window._AgentTools = Tools;   // 内部调试用
window._AgentMem = Memory;
window._AgentLog = Logger;
window._AgentState = State;

Logger.info("Agent OS for Phone 已加载", { version: "0.1.0", tools: Tools.list().length });

})();
