import remarkStringify from "remark-stringify";
import { Root } from "remark-stringify/lib";
import { unified } from "unified";

interface ParentNode {
    type: 'root' | 'list' | 'listItem';
    children: object[];
}

export class MarkdownBuilder {
    private readonly ast: ParentNode = { type: "root", children: [] };
    private parent: ParentNode = this.ast;  // imagine it as current "context"
    private stack: ParentNode[] = [];  // use stack structure because we need to return to parent 

    private pushToAST(node: object) {
        this.parent.children.push(node);
    }

    h1(text: string) {
        this.pushToAST({
            type: "heading",
            depth: 1,
            children: [{ type: "text", value: text }],
        });
        return this;
    }

    paragraph(text: string) {
        this.pushToAST({
            type: "paragraph",
            children: [{ type: "text", value: text }],
        });
        return this;
    }

    link(text: string, url: string) {
        this.pushToAST({
            type: "link",
            url,
            children: [{ type: "text", value: text }],
        });
        return this;
    }

    startList() {
        const node: ParentNode = { type: "list", children: [] };
        this.stack.push(this.parent);
        this.pushToAST(node);
        this.parent = node;
        
        return this;
    }

    startListItem() {
        const node: ParentNode = { type: "listItem", children: [] };
        this.stack.push(this.parent);
        this.pushToAST(node);
        this.parent = node;

        return this;
    }

    end() {
        const parent = this.stack.pop();
        this.parent = parent;

        return this;
    }

    build() {
        console.log(this.ast);
        return unified().use(remarkStringify).stringify(this.ast as Root);
    }
}
