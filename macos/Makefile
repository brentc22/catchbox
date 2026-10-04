APP      := Catchbox
BUNDLE   := $(APP).app
CONTENTS := $(BUNDLE)/Contents
VERSION  := $(shell node -p "require('../package.json').version")
ZIP      := $(APP)-$(VERSION).zip

.PHONY: all build bundle sign install run test zip clean

all: bundle

# One binary for Apple silicon and Intel, so the cask needs no per-architecture download.
ARCHS    := --arch arm64 --arch x86_64
BIN      = $(shell swift build -c release $(ARCHS) --show-bin-path)

build:
	swift build -c release $(ARCHS)

# The app carries its own copy of the CLI's JavaScript, so it never depends on which
# version of the `catchbox` formula happens to be installed — only on a `node`.
bundle: build
	rm -rf $(BUNDLE)
	mkdir -p $(CONTENTS)/MacOS $(CONTENTS)/Resources/catchbox
	cp $(BIN)/$(APP) $(CONTENTS)/MacOS/$(APP)
	sed 's/__VERSION__/$(VERSION)/g' Resources/Info.plist > $(CONTENTS)/Info.plist
	cp Resources/$(APP).icns $(CONTENTS)/Resources/$(APP).icns
	cp -R ../bin ../src ../package.json ../LICENSE $(CONTENTS)/Resources/catchbox/
	$(MAKE) sign

sign:
	codesign --force --deep --sign - $(BUNDLE)
	codesign --verify --verbose $(BUNDLE)

install: bundle
	@osascript -e 'quit app "$(APP)"' 2>/dev/null || true
	@for i in 1 2 3 4 5 6 7 8 9 10; do pgrep -x $(APP) >/dev/null || break; sleep 0.2; done
	rm -rf /Applications/$(BUNDLE)
	cp -R $(BUNDLE) /Applications/
	@echo "installed in /Applications/$(BUNDLE)"

run: install
	open /Applications/$(BUNDLE)

test:
	swift run CatchboxTests

# What the GitHub release carries and the cask downloads. ditto keeps the signature intact.
zip: bundle
	rm -f $(ZIP)
	ditto -c -k --keepParent $(BUNDLE) $(ZIP)
	@shasum -a 256 $(ZIP)

clean:
	rm -rf .build $(BUNDLE) $(APP)-*.zip
