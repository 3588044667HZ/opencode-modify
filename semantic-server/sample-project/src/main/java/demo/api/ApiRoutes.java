package demo.api;

import demo.tasks.TaskEngine;

class ApiRoutes {
    TaskEngine engine() {
        return new TaskEngine();
    }
}
