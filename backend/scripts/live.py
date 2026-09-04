"""Drive the real signing page against the real API, three signers in order.

No mock: the page fetches from the Node backend, stamps with pdf-lib, and posts
real bytes back. Verifies ordering, the hash chain, and completion.
"""
import json, os, subprocess, sys, tempfile, time, urllib.request
from urllib.error import URLError
from websocket import create_connection

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9225
HERE = os.path.dirname(os.path.abspath(__file__))
# A throwaway Chrome profile. Kept in TEMP so a test run never
# leaves tens of megabytes of browser state inside the repo.
PROFILE = os.path.join(tempfile.gettempdir(), "esign-liveprof")
BASE = "http://127.0.0.1:3000"
tokens = sys.argv[1:4]

proc = subprocess.Popen(
    [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
     f"--remote-debugging-port={PORT}", f"--user-data-dir={PROFILE}",
     "--remote-allow-origins=*", "--window-size=1400,1000", "about:blank"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def wait_dev(timeout=25):
    end = time.time() + timeout
    while time.time() < end:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=1)
            return True
        except (URLError, OSError):
            time.sleep(0.3)
    return False

try:
    if not wait_dev():
        print("NO_DEVTOOLS"); sys.exit(3)
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list") as r:
        pages = [t for t in json.load(r) if t.get("type") == "page"]
    ws = create_connection(pages[0]["webSocketDebuggerUrl"], timeout=90)

    mid = [0]
    errors = []
    def send(method, params=None):
        mid[0] += 1
        i = mid[0]
        ws.send(json.dumps({"id": i, "method": method, "params": params or {}}))
        while True:
            m = json.loads(ws.recv())
            if m.get("id") == i:
                return m
            if m.get("method") == "Runtime.exceptionThrown":
                d = m["params"]["exceptionDetails"]
                desc = (d.get("exception") or {}).get("description") or d.get("text")
                errors.append(str(desc).split("\n")[0])

    def ev(expr):
        r = send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
        res = r.get("result", {}).get("result", {})
        return res.get("value", res.get("description"))

    def wait_for(expr, secs=45, label=""):
        end = time.time() + secs
        while time.time() < end:
            v = ev(expr)
            if v:
                return v
            time.sleep(0.4)
        print(f"   TIMEOUT waiting for {label or expr}")
        return None

    send("Runtime.enable"); send("Page.enable")

    NAMES = ["Priya Sharma", "Dillin Nair", "Arun Mehta"]
    hashes = []

    # 1. An out-of-turn signer must be refused BY NAME before anyone signs.
    print("A. signer 2 opens before signer 1 has signed")
    send("Page.navigate", {"url": f"{BASE}/s/{tokens[1]}"})
    wait_for("!document.getElementById('screen-refused').hidden", 30, "refusal")
    print("   refused:", ev("document.getElementById('refusedTitle').textContent"))
    print("   waiting on:", ev("document.getElementById('refusedWaitingName').textContent"))
    print("   only screen visible:", ev(
        "['loading','refused','signing','done'].filter(s=>!document.getElementById('screen-'+s).hidden).join(',')"))

    # 2. Each signer signs in turn.
    for i, tok in enumerate(tokens):
        print(f"\nB{i+1}. {NAMES[i]} signs")
        send("Page.navigate", {"url": f"{BASE}/s/{tok}"})
        if not wait_for("document.querySelectorAll('#pdfContainer canvas').length>0", 45, "render"):
            print("   FAILED to render"); break

        print("   signer:", ev("document.getElementById('signerName').textContent"),
              "|", ev("document.getElementById('signerPosition').textContent"))
        tl = ev("[...document.querySelectorAll('.tl-name')].map(e=>e.textContent).join(', ')")
        print("   timeline (already signed):", tl if tl else "(none)")
        print("   prior hashes shown:", ev("document.querySelectorAll('.tl-hash').length"))

        # Draw a real signature.
        ev("document.getElementById('openMaker').click()")
        wait_for("!document.getElementById('sigModal').hidden", 8, "modal")
        ev("document.getElementById('tabDraw').click()")
        ev("""(function(){
          var c=document.getElementById('drawCanvas'), r=c.getBoundingClientRect();
          function pe(t,x,y){c.dispatchEvent(new PointerEvent(t,{clientX:r.left+x,clientY:r.top+y,pointerId:1,bubbles:true}));}
          pe('pointerdown',30,100);
          for(var x=30;x<=320;x+=10){ pe('pointermove',x,100+40*Math.sin(x/28)); }
          pe('pointerup',320,100);
        })()""")
        ev("document.getElementById('acceptSig').click()")
        wait_for("!!document.querySelector('#sigBox img')", 10, "signature placed")
        ev("(function(){var c=document.getElementById('consentCheck');c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}));})()")
        ev("document.getElementById('submitBtn').click()")

        if not wait_for("!document.getElementById('screen-done').hidden", 60, "done"):
            print("   FAILED to complete")
            print("   error:", ev("document.getElementById('submitError').textContent"))
            break

        h = ev("document.getElementById('doneHash').textContent")
        hashes.append(h)
        print("   result:", ev("document.getElementById('doneTitle').textContent"))
        print("   file  :", ev("document.getElementById('doneFileName').textContent"))
        print("   hash  :", h)
        print("   waiting:", ev("[...document.querySelectorAll('#waitingList li')].map(e=>e.textContent).join(', ')") or "(none)")
        print("   download offered:", ev("!document.getElementById('downloadWrap').hidden"))

    print("\nC. hash chain")
    print("   hashes:", len(hashes), "| all distinct:", len(set(hashes)) == len(hashes))
    for i, h in enumerate(hashes):
        print(f"     signer {i+1}: {h}")

    if errors:
        print("\n   JS errors:")
        for e in errors:
            print("    ", e)
finally:
    proc.terminate()
