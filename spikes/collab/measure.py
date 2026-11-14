"""Size and load-time measurements. Run: python measure.py"""
import asyncio, json, os, tempfile, random
from playwright.async_api import async_playwright
from check import Server, free_port, open_client, wait_text, text_of

random.seed(1)
WORDS = "the quick brown fox jumps over lazy dog cutline frame review clip timeline edit grade mix sound cut".split()


def para(n):
    return " ".join(random.choice(WORDS) for _ in range(n))


async def main():
    tmp = tempfile.mkdtemp()
    srv = Server(free_port(), os.path.join(tmp, "m.db"))
    srv.start()
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        ctx, A = await open_client(br, srv.port, "Alice", "e11d48", "m1")
        frames = []
        A.on("websocket", lambda ws: None)
        # capture frames of the already-open socket through CDP
        cdp = await ctx.new_cdp_session(A)
        await cdp.send("Network.enable")
        cdp.on("Network.webSocketFrameSent", lambda e: frames.append(("sent", len(b), b[0] if b else -1)) if (b := __import__("base64").b64decode(e["response"]["payloadData"])) is not None and e["response"]["opcode"] == 2 else None)
        await A.click(".ProseMirror")
        frames.clear()
        await A.keyboard.type("a")
        await asyncio.sleep(0.5)
        k1 = [(f[2], f[1]) for f in frames]
        frames.clear()
        await A.keyboard.type("b")
        await asyncio.sleep(0.3)
        k2 = [(f[2], f[1]) for f in frames]
        # paste ~100 words as one paragraph
        text = para(100)
        frames.clear()
        await A.evaluate("t => spike.editor.commands.insertContent({type:'paragraph',content:[{type:'text',text:t}]})", text)
        await asyncio.sleep(0.5)
        pasted = [(f[2], f[1]) for f in frames]
        print("keystroke frames (type byte, total bytes incl. type byte):", k1, k2)
        print("paste 100 words (%d chars) frames:" % len(text), pasted)

        # ~5000 words: 50 paragraphs of 100 words, inserted in ONE go (paste) in doc m2, and
        # typed word-by-word (one update per word) in doc m3
        ctx2, P = await open_client(br, srv.port, "Paste", "000000", "m2")
        paras = [para(100) for _ in range(50)]
        await P.evaluate("ps => spike.editor.commands.setContent({type:'doc',content:ps.map(t=>({type:'paragraph',content:[{type:'text',text:t}]}))})", paras)
        await asyncio.sleep(1)
        ctx3, T = await open_client(br, srv.port, "Typed", "000000", "m3")
        await T.evaluate("""async ps => { const ed = spike.editor; ed.commands.setContent('');
          for (let i=0;i<ps.length;i++){ if(i) ed.commands.insertContent({type:'paragraph'}); 
            for (const w of ps[i].split(' ')) { ed.commands.insertContent(w+' '); } await new Promise(r=>setTimeout(r,0)); } }""", paras)
        for _ in range(120):
            await asyncio.sleep(1)
            n = len(srv.get("/text/m3").split())
            if n >= 5000: break
        await asyncio.sleep(1)
        for page_id in ("m2", "m3"):
            before = json.loads(srv.get(f"/stats/{page_id}"))
            words = len(srv.get(f"/text/{page_id}").split())
            load_before = json.loads(srv.get(f"/reload/{page_id}", "POST"))
            snap = json.loads(srv.get(f"/snapshot/{page_id}", "POST"))
            after = json.loads(srv.get(f"/stats/{page_id}"))
            load_after = json.loads(srv.get(f"/reload/{page_id}", "POST"))
            print(page_id, "words", words, "before", before, "load_ms(before snapshot)", round(load_before["load_ms"], 1),
                  "snapshot", snap, "after", after, "load_ms(after snapshot)", round(load_after["load_ms"], 1))
        await br.close()
    srv.kill()

asyncio.run(main())
