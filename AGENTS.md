# House Rules

- Remember each line of code is precious (Including comments to your future self)
- Ensure that you compile the project if its a language that can be compiled
- Ensure that you test the project if it includes tests
- Be sure to update tests that test your changes you made, if the project includes tests
- Run the project if it can be run on your system
- Never commit any changes
- Never push any changes

# Container

You are living inside of a Docker Container called Altivec-Intelligence. This is
Jeff's home-brew container that can run everything from easy peasy web stuff
like Ruby and Node to totally insane stuff like Retro iOS and macOS development.
There are loads of SDK's and C based development tools in /altivec.

It includes:
Core build tooling: build-essential, make, patch, cmake, clang, LLVM, lld, lldb, flex, bison, m4, texinfo, bc, Python 3, Ruby, Go, and standard archive tools.
Apple cross-compilation stack: OSXCross is built with Apple GCC 4.2.1, targeting Mac OS X 10.5 / SDK 10.5. It builds PowerPC, i386, and x86_64 GCC support, then adds /osxcross/target/bin to PATH.
Signing and Apple binary tools: rcodesign for real Apple code signing, ldid for jailbreak-style ad-hoc signing and entitlements, plus ipsw for Mach-O / Obj-C / Swift binary analysis.
Reverse engineering and diagnostics: Radare2 6.1.4 is built from source. The image also installs binwalk, xxd, strace, ltrace, mitmproxy, thrift-compiler, and Go.
Web, Node, and AI-agent tooling: Node.js 22 is installed, npm is upgraded, then global packages are installed including wrangler, jsdom, prettier, js-beautify, webcrack, Claude Code, OpenAI Codex, pi-coding-agent, and opencode-ai. It also installs Google’s Antigravity CLI.
App/media/document utilities: ImageMagick, icon tools, WebP/PNG/JPEG optimizers, SVG conversion tools, ffmpeg, pandoc, xmlstarlet, and libplist-utils.
Repo-specific Altivec tooling: It copies /altivec/bin into the image, puts it on PATH, and validates altivec-release. A later ghcr-action stage bakes in the Altivec repo, builds AltivecCore, AltivecCocoa, and sample apps for Mac and iPhone targets.
Overall, this is not a generic dev container; it is a specialized legacy Apple cross-build, packaging, signing, reverse-engineering, and AI-assisted coding environment for the Altivec project.

# Environment

You are living inside of my mono repo environment controlled by a node.js
app living in /repo/strappy-fleet. There is a mirror of all of my repos in 
/repo/backups and the items we are currently working on are in /repo/checkouts.
Please use strappy-fleet to help Jeff manage his repos. Strappy-Fleet will be 
able to check repos out and clean them up. This is part of a larger goal to 
keep the repos ephemeral to increase the hygiene in repo management.