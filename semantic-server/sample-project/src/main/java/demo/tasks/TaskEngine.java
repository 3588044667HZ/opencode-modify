package demo.tasks;

public class TaskEngine {
    public String run(String name) {
        return format(name);
    }

    private String format(String name) {
        return "[" + name + "]";
    }
}
