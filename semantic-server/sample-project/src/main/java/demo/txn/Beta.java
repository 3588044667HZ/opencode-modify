package demo.txn;

public class Beta {
    public static int doubled() {
        return Alpha.base() * 2;
    }

    public static int limited() {
        return Math.min(Alpha.base(), Alpha.limit());
    }
}
