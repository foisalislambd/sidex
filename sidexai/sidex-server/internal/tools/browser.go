package tools

func init_browser(r *Registry) {
	r.tools["browser_navigate"] = Tool{
		Name: "browser_navigate",
		Description: `Navigate the built-in browser to a URL. Creates a browser window if needed. Returns page title and URL. Use for web automation, testing, or inspecting pages (computer use / browser agent).`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"url":        map[string]interface{}{"type": "string", "description": "Fully-qualified URL to navigate to."},
				"wait_for":   map[string]interface{}{"type": "string", "description": "Optional CSS selector to wait for after navigation."},
				"screenshot": map[string]interface{}{"type": "boolean", "description": "If true, include a screenshot in the result (when supported)."},
			},
			"required": []string{"url"},
		},
	}
	r.tools["browser_screenshot"] = Tool{
		Name:        "browser_screenshot",
		Description: `Take a screenshot of the current browser page or a specific element. Requires an active browser session (call browser_navigate first).`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"selector":  map[string]interface{}{"type": "string", "description": "Optional CSS selector to capture a specific element."},
				"full_page": map[string]interface{}{"type": "boolean", "description": "Capture full page when supported."},
			},
		},
	}
	r.tools["browser_click"] = Tool{
		Name:        "browser_click",
		Description: `Click an element in the built-in browser matching a CSS selector.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"selector": map[string]interface{}{"type": "string", "description": "CSS selector of the element to click."},
			},
			"required": []string{"selector"},
		},
	}
	r.tools["browser_type"] = Tool{
		Name:        "browser_type",
		Description: `Type text into an input/textarea in the built-in browser.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"selector": map[string]interface{}{"type": "string", "description": "CSS selector of the input element."},
				"text":     map[string]interface{}{"type": "string", "description": "Text to type."},
				"clear":    map[string]interface{}{"type": "boolean", "description": "Clear the field before typing."},
			},
			"required": []string{"selector", "text"},
		},
	}
	r.tools["browser_read"] = Tool{
		Name:        "browser_read",
		Description: `Read visible text content from the built-in browser page or a specific element.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"selector":   map[string]interface{}{"type": "string", "description": "CSS selector to read from (default: body)."},
				"max_length": map[string]interface{}{"type": "integer", "description": "Max characters to return (default 5000)."},
			},
		},
	}
	r.tools["browser_scroll"] = Tool{
		Name:        "browser_scroll",
		Description: `Scroll the built-in browser page.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"direction": map[string]interface{}{"type": "string", "description": "Scroll direction: up, down, left, or right."},
				"pixels":    map[string]interface{}{"type": "integer", "description": "Pixels to scroll (default 500)."},
			},
			"required": []string{"direction"},
		},
	}
	r.tools["browser_console"] = Tool{
		Name:        "browser_console",
		Description: `Get captured console logs from the built-in browser session.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"clear": map[string]interface{}{"type": "boolean", "description": "Clear logs after returning them."},
			},
		},
	}
	r.tools["browser_eval"] = Tool{
		Name:        "browser_eval",
		Description: `Evaluate JavaScript in the built-in browser and return the result. Use carefully; prefer specific browser tools when possible.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"expression": map[string]interface{}{"type": "string", "description": "JavaScript expression to evaluate."},
			},
			"required": []string{"expression"},
		},
	}
	r.tools["browser_close"] = Tool{
		Name:        "browser_close",
		Description: `Close the built-in browser session/window.`,
		Parameters:  map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
	}
}
