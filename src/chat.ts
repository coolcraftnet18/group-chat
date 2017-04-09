import { config } from './config';
import { Listen, Listenable, Listener, Unlisten } from './listen';
import { Variable } from './variable';

//
// The <App> UI is bound to a property which implements this interface.
//
export interface AppState {
  nickname: string;
  rooms: Room[];
  currentRoom: Room | null;
  latestError: string;
}

export interface App extends Listenable<AppState> {
  getState: () => AppState;
  createRoom: (name: string) => void;
  selectRoom: (room: Room) => void;
  deleteRoom: (room: Room) => void;
  setNickname: (name: string) => void;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

export interface Room {
  name: string;
  rid: string;
  role: string;
  nickname: string;
  messages: Message[];

  sendMessage: (message: string) => void;
}

export interface Message {
  from: string;
  when: number;
  message: string;
};

//
// Firebase datamodel
//
export interface RoomData {
  private: boolean;
  name: string;
}

type Role = 'owner' | 'applicant' | 'member' | 'banned' | '';
export interface MemberData {
  nickname: string;
  role: Role;
}

//
// Implementation of Application using Firebase.
//
export class AppOnFirebase implements App {
  state: AppState;
  uid: string;
  userListenable: Listenable<firebase.User | null>;
  listener: Listener<AppState>;

  private app: firebase.app.App;
  private pendingUpdate = false;

  constructor() {
    console.log("Application startup ...");

    window.addEventListener('error', (e) => {
      this.displayError(e as any as Error);
    });

    if (typeof firebase === 'undefined') {
      console.error("Firebase script not loaded - offline?");
      return;
    }

    this.app = firebase.initializeApp(config);

    this.userListenable = new Variable<firebase.User | null>((emit) => {
      this.app.auth().onAuthStateChanged((user: firebase.User | null) => {
        emit(user);
      });
    });

    this.userListenable.listen((user) => {
      if (user === null) {
        delete this.uid;
        this.setNickname('anonymous');
        return;
      }

      this.uid = user.uid;
      if (user.displayName) {
        this.setNickname(user.displayName);
      }
    });

    // Read and process each of the rooms.
    this.app.database().ref('rooms').on('child_added', (snapshot) => {
      let info = snapshot!.val()! as RoomData;
      let rid = snapshot!.key!;

      let room = this.findRoom(rid);

      if (room === null) {
        room = new RoomImpl(this, rid, info);
        this.state.rooms.push(room);
      };

      this.updateListeners();
    });

    // Watch for complete removal of a room.
    this.app.database().ref('rooms').on('child_removed', (snapshot) => {
      let room = this.findRoom(snapshot!.key!);
      if (room) {
        console.log("Room was removed: ", room);

        // TODO(koss): Bug when deleting room, messages are selected?
        if (this.state.currentRoom === room) {
          this.state.currentRoom = null;
        }

        for (let i = 0; i < this.state.rooms.length; i++) {
          if (this.state.rooms[i] === room) {
            this.state.rooms.splice(i, 1);
            return;
          }
        }

        this.updateListeners();
      }
    });

    this.state = {
      nickname: 'anonymous',
      rooms: [],
      currentRoom: null,
      latestError: ''
    };
  }

  // TODO(koss): Allow more than one listener.
  listen(listener: Listener<AppState>): Unlisten {
    this.listener = listener;
    this.updateListeners();
    return (() => {
      delete this.listener;
    });
  }

  getState(): AppState {
    return Object.assign({}, this.state);
  }

  updateListeners() {
    if (this.pendingUpdate) {
      return;
    }
    this.pendingUpdate = true;
    Promise.resolve()
      .then(() => {
        this.pendingUpdate = false;
        if (this.listener) {
          this.listener(this.getState());
        }
      });
  }

  signIn(): Promise<void> {
    let provider = new firebase.auth.GoogleAuthProvider();
    provider.addScope('profile');
    provider.addScope('email');
    provider.addScope('https://www.googleapis.com/auth/plus.login');
      // signInWithPopup does not work on mobile devices
    return this.app.auth().signInWithRedirect(provider) as Promise<void>;
  }

  signOut(): Promise<void> {
    return this.app.auth().signOut() as Promise<void>;
  }

  setNickname(name: string) {
    this.state.nickname = name;
    this.updateListeners();
  }

  selectRoom(room: RoomImpl) {
    if (room && room !== this.state.currentRoom) {
      this.state.currentRoom = room;
      room.ensureMember();
      room.listenForMessages();
      this.updateListeners();
    }
  }

  findRoom(rid: string): RoomImpl | null {
    for (let room of this.state.rooms) {
      if (room.rid === rid) {
        return room as RoomImpl;
      }
    }
    return null;
  }

  createRoom(name: string) {
    this.ensureSignedIn("create a room");

    let ref = this.app.database().ref('rooms').push();

    let roomInfo: RoomData = {
      private: false,
      name: name
    };

    ref.set(roomInfo)
      .then(() => {
        let member: MemberData = {
          nickname: this.state.nickname,
          role: 'owner',
        };
        return this.getMemberRef(ref.key!).set(member);
      })
      .then(() => {
        let room = this.findRoom(ref.key!);
        if (!room) {
          throw new Error("Can't select room: " + ref.key);
        }
        this.selectRoom(room);
      })
      .catch((error) => this.displayError(error));
  }

  deleteRoom(room: RoomImpl) {
    // May fail if there are no messages - ignore.
    this.getMessagesRef(room.rid).set(null);

    this.app.database().ref('rooms').child(room.rid).set(null)
      .then(() => {
        this.app.database().ref('members').child(room.rid).set(null);
      })
      .catch((e) => {
        this.displayError(e);
      });
  }

  getMemberRef(rid: string, uid?: string): firebase.database.Reference {
    if (!uid) {
      uid = this.uid;
    }
    return this.app.database().ref('members').child(rid).child(uid);
  }

  getMessagesRef(rid: string): firebase.database.Reference {
    return this.app.database().ref('messages').child(rid);
  }

  ensureSignedIn(reason: string) {
    if (!this.uid) {
      throw new Error("Must be siged in to " + reason + ".");
    }
  }

  displayError(error: Error) {
    console.log(error);
    this.state.latestError = error.message;
    this.updateListeners();
  }
}

export class RoomImpl implements Room {
  name: string;
  rid: string;
  role: string;
  nickname: string;
  messages: Message[] = [];
  hasMessage: {[rid: string]: boolean} = {};
  nicknameOf: {[uid: string]: string} = {};

  private messageQuery: firebase.database.Query;

  constructor(private app: AppOnFirebase,
              rid: string,
              info: RoomData) {
    this.name = info.name;
    this.rid = rid;
    this.setUnknownMembership();

    // Update the room when the user changes.
    this.app.userListenable.listen((user) => {
      if (user === null) {
        this.setUnknownMembership();
        this.app.updateListeners();
        return;
      }

      this.app.getMemberRef(this.rid, user.uid)
        .once('value', (snapshot) => {
          let member = snapshot.val() as MemberData;
          if (member) {
            this.role = member.role;
            this.nickname = member.nickname;
          } else {
            this.setUnknownMembership();
          }
          this.app.updateListeners();
        })
        .catch((e) => this.app.displayError(e));
    });
  }

  setUnknownMembership() {
    this.role = '';
    this.nickname = 'unknown';
  }

  ensureMember() {
    // TODO(koss): Read first, and then try 'member' or 'applicant'.
    if (this.role === '') {
      let member: MemberData = {
        nickname: this.app.state.nickname,
        role: 'member',
      };
      this.app.getMemberRef(this.rid).set(member);
    }
  }

  sendMessage(message: string) {
    this.app.ensureSignedIn('send a message');

    this.app.getMessagesRef(this.rid)
      .push({
        from: this.app.uid,
        when: firebase.database.ServerValue.TIMESTAMP,
        message: message
      });
  }

  listenForMessages() {
    if (this.messageQuery) {
      return;
    }
    // TODO(koss): Garbage collect message listener?
    this.messageQuery = this.app.getMessagesRef(this.rid).orderByKey();
    this.messageQuery.on('child_added', (snapshot) => {
      let message = snapshot!.val() as Message;
      this.ensureMessage(snapshot!.key!, message);
    });
  }

  ensureMessage(mid: string, message: Message) {
    if (this.hasMessage[mid]) {
      return;
    }
    let storedMessage = this.addMessage(mid, message);
    if (this.nicknameOf[message.from]) {
      // Re-write the from field to be the user's nickname.
      storedMessage.from = this.nicknameOf[message.from];
      this.app.updateListeners();
    } else {
      this.app.getMemberRef(this.rid, message.from).once('value', (snapshot) => {
        let member = snapshot.val() as MemberData;

        this.nicknameOf[message.from] = member.nickname;
        message.from = member.nickname;
        storedMessage.from = member.nickname;
        this.app.updateListeners();
      });
    }
  }

  addMessage(mid: string, message: Message): Message {
    this.messages.push(message);
    this.hasMessage[mid] = true;
    return this.messages.slice(-1)[0];
  }
}
