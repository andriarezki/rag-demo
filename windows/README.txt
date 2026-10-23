PAGEWISE (working name) - DOCUMENT ASSISTANT, PILOT VERSION
============================================================

What it is
----------
A small web page for asking questions about the content of your documents (PDF, TXT, MD).
Every answer shows its source: the file name and the page number. If the answer is not in the
documents, the app says so instead of guessing.
Nothing needs to be installed: everything is in this folder (including Node.js, in the "node" folder).

What you need
-------------
- One Windows PC (Windows 10/11 or Windows Server 2016+, 64-bit) on the LAN, with at least 8 GB RAM (16 GB is better).
- A folder of approved, non-confidential documents. The app only READS this folder.
- No internet is needed, UNLESS you fill in GEMINI_API_KEY (see "Offline mode and AI mode").

First start (about 5 minutes)
-----------------------------
1. Copy this whole folder to the PC, for example to D:\Pagewise.
2. Open config.env with Notepad:
   - Change APP_PASSWORD to your own password (the app refuses to start while it is still the placeholder).
   - Change DOCS_DIR to the pilot documents folder, for example D:\Pilot-Documents.
   Save the file.
3. Double-click ingest.bat. Wait for "Indexed ... chunks from ... documents".
4. Double-click start.bat. Keep that window open.
5. Open http://localhost:3000 on that PC. From another PC on the LAN: http://IP-ADDRESS-OF-THE-PC:3000
   (find the address with the command ipconfig). Sign in with APP_USER and APP_PASSWORD.
   If Windows shows a Firewall question, allow access on Private/Domain networks.

Adding or replacing documents
-----------------------------
Put the files in DOCS_DIR, run ingest.bat, then close and restart start.bat.
Every ingest rebuilds the index from scratch, so files you delete also disappear from the index.

Offline mode and AI mode
------------------------
- Offline mode (GEMINI_API_KEY empty): search only matches words (keywords plus a word-hash index). The result is the
  most relevant passage, not a written answer. Quality is limited: different words for the same idea can be missed.
  No data leaves the PC.
- AI mode (GEMINI_API_KEY filled in): better search by meaning, and a short written answer with citations [1] [2].
  CONSEQUENCE: the relevant passages are sent to a Google service for every question, and the PC needs internet access.
  Use it only for non-confidential documents and only after approval from your manager and the head-office IT team.
  After adding or changing the key, run ingest.bat again (the index is built differently).

Limits to know about
--------------------
- Scanned PDFs (images) have no text and are skipped. Ingest lists them. They need OCR first.
- Tables and formulas in PDFs can come out garbled.
- The app does not replace reading the source. Always check the cited page.
- Wrong or missed answers can happen. Write down examples for the pilot evaluation.

Notes and security
------------------
- Every question is logged in data\questions.log (time, IP, question, result, sources) for the pilot evaluation.
  Empty the LOG_QUESTIONS line in config.env to turn logging off, and tell the users.
- Keep this port on the LAN only. Do not forward it to the internet.
- Register the system with the head-office IT team (PC location, owner, data used, who may access it) before use.
- To stop: close the start.bat window.

Common problems
---------------
- The login keeps appearing: check APP_USER and APP_PASSWORD in config.env, then restart start.bat.
- The page does not open from another PC: check the Windows Firewall and that both PCs are on the same network.
- "No readable ... text found": the folder is empty or every PDF is a scan.
- Any other error: take a screenshot of the black window and send it.

Built from the open-source project github.com/andriarezki/rag-demo (MIT license). This package has not been tested on a real Windows machine yet.
