#!/bin/bash
# Builds, signs, installs, runs, and quits Paseo Micro, the menu bar app that owns the Creator Micro 2.
#
#   Scripts/app.sh build                  Build the app and the micro command, assemble the bundle, and sign it.
#   Scripts/app.sh sign                   Sign the assembled bundle again.
#   Scripts/app.sh install                Build and sign, quit the app, replace /Applications/Paseo Micro.app, and open it.
#   Scripts/app.sh run [installed|build]  Open the app; PASEO_MICRO_* variables in the environment go to it.
#   Scripts/app.sh quit                   Quit the running app, wherever it runs from.
#
# PASEO_MICRO_SIGNING_IDENTITY is required for build, sign, and install.
# PASEO_MICRO_APP_DIR chooses the folder for PaseoMicro.app; the default is build/.
# `run` opens the installed copy if there is one, else the build;
# `run build`, or setting PASEO_MICRO_APP_DIR, opens the build.
#
# The bundle:
#   Contents/MacOS/PaseoMicro        the menu bar app
#   Contents/MacOS/micro             the bridge client
#   Contents/Resources/Assets.car    the layered app icon that actool compiles from App/AppIcon.icon,
#                                    with light and dark appearances
#   Contents/Resources/AppIcon.icns  the flattened fallback icon from the same compilation
#   Contents/Resources/*.bundle     SwiftPM resources, including menu bar template PDFs
#
# Both executables are signed with the identifier co.dododo.paseo-micro and the same certificate,
# so that the Accessibility permission survives rebuilds and the move to /Applications.
# The Info.plist's PaseoMicroRepository is the repository's main checkout,
# where the menu finds README.md.
set -euo pipefail

cd "$(dirname "$0")/.."

identity="${PASEO_MICRO_SIGNING_IDENTITY:-}"
case "${1:-}" in
    build|sign|install)
        if [ -z "$identity" ]; then
            echo "error: set PASEO_MICRO_SIGNING_IDENTITY to your Apple Development certificate name" >&2
            echo "Find certificate names with: security find-identity -v -p codesigning" >&2
            exit 1
        fi
        ;;
esac
identifier="co.dododo.paseo-micro"
folder="${PASEO_MICRO_APP_DIR:-build}"
app="$folder/PaseoMicro.app"
installed="/Applications/Paseo Micro.app"

requirement() {
    codesign --display --requirements - "$1" 2>&1 | sed -n 's/^designated => //p'
}

assemble() {
    swift build -c release --product PaseoMicro
    swift build -c release --product micro
    local bin version
    bin="$(swift build -c release --show-bin-path)"
    version="$(sed -n 's/^public let paseoMicroVersion = "\(.*\)"$/\1/p' Sources/PaseoMicroCore/Version.swift)"
    if [ -z "$version" ]; then
        echo "error: no version in Sources/PaseoMicroCore/Version.swift" >&2
        exit 1
    fi

    rm -rf "$app"
    mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
    cp App/Info.plist "$app/Contents/Info.plist"
    plutil -replace CFBundleShortVersionString -string "$version" "$app/Contents/Info.plist"
    plutil -replace CFBundleVersion -string "$(git rev-list --count HEAD)" "$app/Contents/Info.plist"
    plutil -replace PaseoMicroRepository -string "$(repository)" "$app/Contents/Info.plist"
    local partial minos
    partial="$(mktemp -d)"
    minos="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' App/Info.plist)"
    # actool needs absolute paths: in some shells it cannot read its working directory
    # and fails with "currentDirectoryPath is unexpectedly nil" (2026-10-30).
    local root resources
    root="$(pwd -P)"
    case "$app" in
        /*) resources="$app/Contents/Resources" ;;
        *) resources="$root/$app/Contents/Resources" ;;
    esac
    xcrun actool "$root/App/AppIcon.icon" --compile "$resources" \
        --app-icon AppIcon --output-partial-info-plist "$partial/partial.plist" \
        --minimum-deployment-target "$minos" --target-device mac --platform macosx \
        > "$partial/actool.plist"
    /usr/libexec/PlistBuddy -c "Delete :CFBundleIconFile" -c "Delete :CFBundleIconName" "$app/Contents/Info.plist" 2> /dev/null || true
    /usr/libexec/PlistBuddy -c "Merge $partial/partial.plist" "$app/Contents/Info.plist"
    rm -rf "$partial"
    if [ ! -f "$app/Contents/Resources/Assets.car" ] || [ ! -f "$app/Contents/Resources/AppIcon.icns" ]; then
        echo "error: actool did not produce the app icon in $app/Contents/Resources" >&2
        exit 1
    fi
    cp "$bin/PaseoMicro" "$app/Contents/MacOS/PaseoMicro"
    cp "$bin/micro" "$app/Contents/MacOS/micro"
    cp -R "$bin/paseo-creator-micro_PaseoMicro.bundle" "$app/Contents/Resources/"
    echo "Assembled $app (version $version)"
}

# The repository's main checkout, also when this runs in a linked worktree,
# so that an installed app does not point to a worktree that goes away.
repository() {
    local common
    common="$(git rev-parse --path-format=absolute --git-common-dir)"
    if [ "$(basename "$common")" = ".git" ]; then
        dirname "$common"
    else
        git rev-parse --show-toplevel
    fi
}

sign() {
    if [ ! -d "$app" ]; then
        echo "error: $app does not exist; run \`mise run build:app\` first" >&2
        exit 1
    fi
    # Inner code first, then the bundle, which seals it.
    codesign --force --sign "$identity" --identifier "$identifier" --timestamp=none "$app/Contents/MacOS/micro"
    codesign --force --sign "$identity" --timestamp=none "$app"
    codesign --verify --strict --deep "$app"
    local app_requirement helper_requirement
    app_requirement="$(requirement "$app")"
    helper_requirement="$(requirement "$app/Contents/MacOS/micro")"
    echo "App:    $app_requirement"
    echo "Helper: $helper_requirement"
    if [ "$app_requirement" != "$helper_requirement" ]; then
        echo "error: the app and the helper have different designated requirements" >&2
        exit 1
    fi
    echo "Signed $app"
}

# Quits every running copy, the installed one or a build, and waits until it exits.
quit_app() {
    pgrep -x PaseoMicro > /dev/null || return 0
    osascript -e "quit app id \"$identifier\"" > /dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        pgrep -x PaseoMicro > /dev/null || return 0
        sleep 0.5
    done
    pkill -x PaseoMicro || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        pgrep -x PaseoMicro > /dev/null || return 0
        sleep 0.5
    done
    echo "error: Paseo Micro did not quit" >&2
    exit 1
}

# Copies the signed build next to the installed app under a temporary name, quits the app,
# and renames the copy into place, so that /Applications never holds a partial bundle.
install_app() {
    local parent staging previous
    parent="$(dirname "$installed")"
    staging="$parent/.Paseo Micro.app.installing"
    previous="$parent/.Paseo Micro.app.previous"
    rm -rf "$staging" "$previous"
    ditto "$app" "$staging"
    codesign --verify --strict --deep "$staging"
    quit_app
    if [ -e "$installed" ]; then
        mv "$installed" "$previous"
    fi
    if ! mv "$staging" "$installed"; then
        echo "error: could not move the new app to $installed" >&2
        if [ -e "$previous" ]; then
            mv "$previous" "$installed"
        fi
        exit 1
    fi
    rm -rf "$previous"
    echo "Installed $installed"
    open "$installed"
}

case "${1:-}" in
    build)
        assemble
        sign
        ;;
    sign)
        sign
        ;;
    install)
        assemble
        sign
        install_app
        ;;
    run)
        choice="${2:-}"
        if [ -z "$choice" ]; then
            if [ -z "${PASEO_MICRO_APP_DIR:-}" ] && [ -d "$installed" ]; then
                choice=installed
            else
                choice=build
            fi
        fi
        case "$choice" in
            installed) target="$installed" hint="mise run install:app" ;;
            build) target="$app" hint="mise run build:app" ;;
            *)
                echo "error: run takes \`installed\` or \`build\`, not \`$choice\`" >&2
                exit 64
                ;;
        esac
        if [ ! -d "$target" ]; then
            echo "error: $target does not exist; run \`$hint\` first" >&2
            exit 1
        fi
        env_args=()
        while IFS='=' read -r name value; do
            env_args+=(--env "$name=$value")
        done < <(env | grep '^PASEO_MICRO_' | grep -v '^PASEO_MICRO_SIGNING_IDENTITY=\|^PASEO_MICRO_APP_DIR=' || true)
        echo "Opening $target"
        open -n ${env_args[@]+"${env_args[@]}"} "$target"
        ;;
    quit)
        quit_app
        ;;
    *)
        sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//' >&2
        exit 64
        ;;
esac
