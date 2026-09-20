const QUESTION_PATTERN = /(?:[?？]|什么|哪(?:个|种|些|里)?|多少|怎么|如何|是否|是不是|吗\s*$|呢\s*$|\b(?:what|which|who|where|when|why|how|do i|did i|am i|is my|are my)\b)/i;
const PREFERENCE_PATTERNS = [
    /(?:我|本人).{0,24}(?:最喜欢|喜欢|偏好|更喜欢|爱吃|爱看|爱玩|不喜欢|讨厌|习惯|常用|倾向于)/i,
    /(?:我的).{0,24}(?:偏好|习惯|最爱|最喜欢|默认).{0,40}(?:是|为|用|：|:)/i,
    /\b(?:i|we)\s+(?:like|love|prefer|dislike|hate|usually|normally|tend to)\b/i,
    /\bmy\s+(?:favorite|favourite|preference|habit|default)\b/i
];
const FACT_PATTERNS = [
    /(?:^|[，。；;\s])我(?:叫|是|来自|住在|出生于|就读于|毕业于|在读|从事|目前在|现在在)/i,
    /(?:^|[，。；;\s])我的(?:名字|姓名|母语|职业|生日|家乡|手机号|邮箱).{0,24}(?:是|为|叫|：|:)/i,
    /\b(?:i am|i'm|i live in|i come from|i work as|i study at|my\s+(?:name|native language|job|occupation|birthday|hometown|phone number|email)\s+(?:is|are))\b/i
];
const STABLE_PREFERENCE_PATTERNS = [
    /(?:以后|今后|从现在起|每次|始终|永远|默认).{0,80}(?:请|要|先|不要|别|避免|保持|使用|给|回答|推荐|写)/i,
    /\b(?:from now on|in future|always|never)\b.{1,120}/i
];
const DYNAMIC_CURRENT_FACT_PATTERN = /(?:天气|气温|降雨|空气质量|股价|汇率|价格|票价|库存|余额|实时|当前.{0,8}(?:指标|数据|状态)|今天.{0,8}(?:天气|价格))|\b(?:weather|temperature|stock price|exchange rate|current price|live status|real[- ]time)\b/i;

export function isPersonalFactQuestion(text) {
    return /(?:我|我的).{0,32}(?:喜欢|偏好|最爱|名字|姓名|生日|住|来自|职业).{0,24}(?:什么|哪(?:个|种|里)?|多少|是吗|吗|呢)[^?？。！!]{0,20}[?？。！!]*$/i.test(text) ||
        /(?:我|我的).{0,32}(?:喜欢|偏好|最爱|名字|姓名|生日|住|来自|职业).{0,24}(?:什么|哪(?:个|种|里)?|多少|是吗|吗|呢)[^?？。！!]{0,20}[?？。！!]*\s*(?:(?:请)?(?:从|根据|查看|查找|查询|搜索|检索).{0,80}(?:历史|记忆|记录|对话|聊天).{0,30}|(?:请)?(?:到|在).{0,40}(?:历史|记忆|记录|对话|聊天).{0,30}(?:找|查|看|搜索|检索))[?？。！!]*$/i.test(text) ||
        /\b(?:what|which|where|when|who).{0,40}\b(?:my|i)\b|\bdo i\s+(?:like|prefer)|\bwhat is my\b/i.test(text);
}

export function isDynamicCurrentFactQuery(text) {
    return DYNAMIC_CURRENT_FACT_PATTERN.test(text) && QUESTION_PATTERN.test(text);
}

export function isPurePersonalFactStatement(text) {
    const content = text.trim();
    if (!content || isPersonalFactQuestion(content) || isQuestionOnly(content) || DYNAMIC_CURRENT_FACT_PATTERN.test(content))
        return false;
    return PREFERENCE_PATTERNS.some((pattern) => pattern.test(content)) ||
        FACT_PATTERNS.some((pattern) => pattern.test(content)) ||
        STABLE_PREFERENCE_PATTERNS.some((pattern) => pattern.test(content));
}

export function isTaskLinkedUserFeedback(text) {
    const feedback = /(?:以后|下次|不要|别再|应该|改成|保持|避免|更喜欢)|\b(?:next time|from now on|do not|don't|should|prefer)\b/i.test(text);
    const artifact = /(?:刚才|前面|这次|你(?:写|做|给|生成|回答)|代码|实现|修改|方案|文档|测试|输出|结果|兜底)|\b(?:your|the|this|previous)\s+(?:code|implementation|answer|output|result|document|test|fallback)\b/i.test(text);
    return feedback && artifact;
}

export function isQuestionLike(text) {
    return QUESTION_PATTERN.test(text.trim());
}

function isQuestionOnly(text) {
    if (!QUESTION_PATTERN.test(text))
        return false;
    return !PREFERENCE_PATTERNS.some((pattern) => pattern.test(text)) &&
        !FACT_PATTERNS.some((pattern) => pattern.test(text)) &&
        !STABLE_PREFERENCE_PATTERNS.some((pattern) => pattern.test(text));
}
