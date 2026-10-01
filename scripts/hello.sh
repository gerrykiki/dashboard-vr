#!/bin/sh
# 範例 script：POST /api/scripts/hello.sh  body: {"args": ["world"]}
echo "Hello, ${1:-dashboard}!"
