package main

import "encoding/json"

func jsonUnmarshal(text string, out any) error { return json.Unmarshal([]byte(text), out) }
