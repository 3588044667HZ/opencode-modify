package demo.tasks;

class TaskWorker {
    static void work() {
        TaskEngine engine = new TaskEngine();
        engine.run("worker");
    }
}
