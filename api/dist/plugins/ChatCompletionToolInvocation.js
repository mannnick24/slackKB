export class AgentChatCompletionToolInvocation {
    tool;
    args;
    ctx;
    constructor(tool, args, ctx = {}) {
        this.tool = tool;
        this.args = args;
        this.ctx = ctx;
    }
    get function() {
        return this.tool.function;
    }
    async finalise() {
        return this.tool.finalise?.(this.ctx);
    }
    async invoke() {
        return this.tool.impl(this.args, this.ctx);
    }
}
