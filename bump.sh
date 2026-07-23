#!/bin/bash
# Bump the extension patch version
MANIFEST="/Users/chaztyler/job-search/extension/manifest.json"
current=$(node -e "console.log(require('$MANIFEST').version)")
parts=(${current//./ })
major=${parts[0]}
minor=${parts[1]}
patch=${parts[2]:-0}
new="$major.$minor.$((patch+1))"
sed -i '' "s/\"version\": \"$current\"/\"version\": \"$new\"/" "$MANIFEST"
echo "applyapply $current → $new"
