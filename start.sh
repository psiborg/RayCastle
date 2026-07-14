#!/bin/bash
python3 -m http.server 5666 &
sleep 1
open http://localhost:5666
wait
